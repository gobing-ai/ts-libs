---
schema_version: 1
name: Ordered maker fallback chains in DecisionHub catalogs and decide options
status: todo
template: feature-impl
created_at: 2026-10-19T18:42:30.719Z
updated_at: "2026-10-19T18:43:16.294Z"
feature_id: O2

dependencies: ["0117", "0116"]
---

## 0118. Ordered maker fallback chains in DecisionHub catalogs and decide options

### Background

Implements: R2 — A maker chain advances only on backend failure; R3 — An exhausted chain returns the declared fallback with the last failure; R4 — Chains are validated like single names.

Today a decision routes to exactly one maker (`maker?: string`, `packages/ai-decision/src/types.ts:47,53`, `schema.ts:63,75`; per-call `DecideOptions.maker`, `hub.ts:101`). Downstream needs "local first, hosted when the local backend is unavailable" — e.g. Spur's laya-local decisions fell back to static defaults for days because the worker script was missing, when a second maker could have answered. ADR-040 item 2; design `docs/design/ai-decision-catalog.md` § Maker chains, shadow and diagnostics (algorithm steps 1–4).

### Requirements

- [ ] R1. Types (`packages/ai-decision/src/types.ts`): add `export type MakerRef = string | readonly string[]`. `DecisionDefinition.maker` (`:47`) and `CatalogDefaults.maker` (`:53`) become `MakerRef`. The loader keeps the authored form (string stays string), so single-name catalogs round-trip unchanged.
- [ ] R2. Schema:
  - Zod (`src/schema.ts:63,75`): `maker: z.union([MakerNameSchema, z.array(MakerNameSchema).min(1)]).optional()`, where `MakerNameSchema = z.string().regex(MAKER_NAME_PATTERN)`. Reject duplicate names in one list with a refine ("maker list repeats '<name>'").
  - JSON schema (`schemas/decision-catalog.schema.json:20,215`): `oneOf` string-with-pattern / array (`minItems: 1`, `uniqueItems: true`, items with pattern). Keep the description text; append "or an ordered fallback list (ADR-040)".
  - `src/catalog.ts:356` copies `raw.maker` unchanged.
- [ ] R3. Load checks (`hub.ts:184-215`): `defaults.maker` and each decision's `maker` are normalized with a module-private `toChain(ref: MakerRef): readonly string[]`; **every** name must be registered, else the existing `DecisionCatalogError` (same `field: 'maker'`) naming the first unregistered name. All-or-nothing staging is unchanged.
- [ ] R4. `DecideOptions.maker` (`hub.ts:101`) becomes `MakerRef`. Before any backend call: an empty array, a duplicate, or any unregistered name throws `UnknownDecisionMakerError` (empty/duplicate: name `''` / the duplicate, message says why). Hub `defaultMaker` stays a single string.
- [ ] R5. `decide` (`hub.ts:262-341`): extract the current single-maker body (resolve → ask → validate → type check → confidence gate → result/fallback) into `private async askOne(makerName, definition, defaults, request, start): Promise<{ result: DecisionResult; failed: boolean }>` — `failed` is true exactly for `no-backend`/`timeout`/`error`. `decide` loops the chain: stop at the first `failed === false`; otherwise continue. After exhaustion return the last failed result (declared fallback, last reason/maker/error). Re-stamp `durationMs` to cover the whole call.
- [ ] R6. `attempts`: add `export interface DecisionAttempt { readonly maker: string; readonly reason: DecisionResultBase['reason']; readonly durationMs: number; readonly error?: DecisionErrorInfo }` and `readonly attempts?: readonly DecisionAttempt[]` on `DecisionResultBase`. Set iff the chain tried more than one maker; each attempt's `durationMs` is its own.
- [ ] R7. Descriptor (`hub.ts:83`, `describe` at `:236-251`): keep `maker: string` = first name of the effective chain; add `readonly makers: readonly string[]` = full effective chain. `effectiveMakerName` (`:345`) becomes `effectiveChain(...)`; `maker = chain[0]`.
- [ ] R8. Tests in `packages/ai-decision/tests/hub.test.ts` (+ `schema.test.ts`, `catalog.test.ts` for R2): failure modes 1–10 in Design, recorded via `decideAndRecord`; regenerate `tests/output/hub-e2e-transcript.json` (only new cases may appear; existing entries must be byte-identical — proves feature R6 for chains).
- [ ] R9. Docs:
  - `docs/design/ai-decision-catalog.md` field reference (`:91,105`): `maker` type "maker name or non-empty list".
  - Mark § Maker chains as implemented for the chain part.
  - `packages/ai-decision/README.md`: a "Maker chains" subsection under DecisionHub with a two-line YAML example and the advance rule.
  - `CHANGELOG.md`: note that `DecisionDefinition.maker` / `CatalogDefaults.maker` widen to `MakerRef` (type-level change for code that reads catalogs directly; `describe().maker` stays `string`).

### Acceptance Criteria

- [ ] AC1 — A maker chain advances only on backend failure
- [ ] AC2 — An exhausted chain returns the declared fallback with the last failure
- [ ] AC3 — Chains are validated like single names

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

**Chosen.** An ordered chain resolved per call, reusing the single-maker body unchanged per element. Advance only on backend failure. The design section's algorithm steps 1–4 are normative.

**Rejected.**
- Advancing on `low-confidence` (a confidence cascade): sampled makers' confidence is a unanimity vote (`docs/design/llm-agent-decision-backend.md` § Confidence granularity), so a cascade would mostly measure sample agreement; deferred until calibration exists (ADR-040 Consequences).
- Normalizing `maker` to an array at load: changes the loaded shape for every single-name catalog and breaks consumers comparing strings.
- A registry-level alias ("fast" → [fm-local, typesafe]): a second naming layer; a catalog `defaults.maker` list already covers it.
- Retrying the same maker: retries belong to the maker (`maxRetries`), not the hub.

**Frozen names.** `MakerRef`, `DecisionAttempt`, `DecisionResultBase.attempts`, `DecisionDescriptor.makers`, private `toChain`, `askOne`, `effectiveChain`.

**Invariants.**
- Single-name decisions produce byte-identical results (no `attempts`, same `maker`).
- `decide` never rejects for backend outcomes; caller errors still throw before any backend call.
- At most one `ask` per maker per call; makers after the answering one are never resolved (lazy factories stay unbuilt).
- `result.maker` is the maker whose outcome is returned.

**Failure modes, written before the code:**
1. [fm-local, typesafe]; fm-local factory throws `DecisionConfigError` → typesafe accepted; `attempts` = [fm-local no-backend + error, typesafe accepted]; `maker: 'typesafe'`.
2. [fm-local, typesafe]; fm-local low-confidence → returned as low-confidence from fm-local; typesafe never resolved (spy on its factory).
3. [a, b] both reject `DecisionBackendError` → fallback, reason `error`, `maker: 'b'`, `error` from b, `attempts` length 2.
4. [a, b]; a times out, b answers invalid → fallback, reason `error`, maker b.
5. Single string → no `attempts` key; transcript entries unchanged.
6. Catalog decision maker `[fm-local, nope]` → `DecisionCatalogError` field `maker`, decision id, nothing registered.
7. Catalog `maker: []` → schema rejects at parse (`DecisionCatalogError` from the loader).
8. Catalog `maker: [a, a]` → rejected (zod refine and JSON-schema `uniqueItems`).
9. Per-call `{ maker: ['typesafe', 'nope'] }` → `UnknownDecisionMakerError` before any `ask` (spy).
10. `describe` on a `[fm-local, typesafe]` decision → `maker: 'fm-local'`, `makers: ['fm-local', 'typesafe']`; on a single-name decision → `makers: [name]`.

**Anti-patterns.** No parallel asks across the chain; no new error class; no change to `fallbackResult`'s reason mapping; no `low-confidence` advance flag "for later".

### Plan

1. **Tests first:** schema/catalog cases 6–8 in `tests/schema.test.ts` / `tests/catalog.test.ts`; hub cases 1–5, 9–10 in `tests/hub.test.ts` (scripted makers via the existing helpers, `decideAndRecord`). Run `bun test packages/ai-decision` — new cases fail.
2. R1–R2 (types, zod, JSON schema, loader). Rerun schema/catalog tests.
3. R3–R4 load and per-call validation.
4. R5 extract `askOne` with no behaviour change; run the **existing** suite before adding the loop — it must stay green.
5. R5 loop + R6 attempts + R7 descriptor. Run the full package suite; regenerate the transcript; review its diff (only new cases).
6. Docs and CHANGELOG (R9).
7. Gate: `bun run spur-check && bun run build`; `git status` shows only the files below.

**Files touched:** `packages/ai-decision/src/{types.ts, schema.ts, catalog.ts, hub.ts}`, `packages/ai-decision/schemas/decision-catalog.schema.json`, `packages/ai-decision/tests/{hub.test.ts, schema.test.ts, catalog.test.ts, output/hub-e2e-transcript.json}`, `packages/ai-decision/README.md`, `docs/design/ai-decision-catalog.md`, `CHANGELOG.md`.

**Depends on:** 0117 (attempts reuse `DecisionErrorInfo` and the catch path), 0116 (both edit `README.md` and the JSON schema maker description lists built-ins; serialize behind the O1 docs finalize).

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- Feature O2; ADR-040, ADR-033 (amended); `docs/design/ai-decision-catalog.md` § Maker chains, shadow and diagnostics.
- Confidence granularity rationale: `docs/design/llm-agent-decision-backend.md:142-151`.

**Premises (verified 2026-10-19):**

- `packages/ai-decision/src/types.ts:47,53` — `maker?: string` on decision and defaults.
- `packages/ai-decision/src/schema.ts:63,75` — `z.string().regex(MAKER_NAME_PATTERN).optional()`.
- `packages/ai-decision/schemas/decision-catalog.schema.json:20,215` — `maker` is `type: string` with pattern.
- `packages/ai-decision/src/catalog.ts:356` — loader copies `raw.maker` as-is.
- `packages/ai-decision/src/hub.ts:184-215` — load checks one name per decision/defaults; `:262-341` single-maker decide body; `:345` `effectiveMakerName`; `:83` descriptor `maker: string`; `:101` `DecideOptions.maker?: string`.
- `packages/ai-decision/tests/hub.test.ts:38-43` — transcript containment check.

### History

- 2026-10-19T18:43:16.294Z backlog → todo (system)

