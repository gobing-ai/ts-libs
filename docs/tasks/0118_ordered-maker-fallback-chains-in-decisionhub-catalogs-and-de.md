---
schema_version: 1
name: Ordered maker fallback chains in DecisionHub catalogs and decide options
status: done
template: feature-impl
created_at: 2026-10-19T18:42:30.719Z
updated_at: "2026-10-19T21:13:43.397Z"
feature_id: O2

dependencies: ["0117", "0116"]
done_forced: "false"
done_reason: unforced close; PASS artifact at .spur/memory/evidence/0118-verdict.json
---

## 0118. Ordered maker fallback chains in DecisionHub catalogs and decide options

### Background

Implements: R2 — A maker chain advances only on backend failure; R3 — An exhausted chain returns the declared fallback with the last failure; R4 — Chains are validated like single names.

Today a decision routes to exactly one maker (`maker?: string`, `packages/ai-decision/src/types.ts:47,53`, `schema.ts:63,75`; per-call `DecideOptions.maker`, `hub.ts:101`). Downstream needs "local first, hosted when the local backend is unavailable" — e.g. Spur's laya-local decisions fell back to static defaults for days because the worker script was missing, when a second maker could have answered. ADR-040 item 2; design `docs/design/ai-decision-catalog.md` § Maker chains, shadow and diagnostics (algorithm steps 1–4).

### Requirements

- [x] R1. Types (`packages/ai-decision/src/types.ts`): add `export type MakerRef = string | readonly string[]`. `DecisionDefinition.maker` (`:47`) and `CatalogDefaults.maker` (`:53`) become `MakerRef`. The loader keeps the authored form (string stays string), so single-name catalogs round-trip unchanged.
- [x] R2. Schema:
  - Zod (`src/schema.ts:63,75`): `maker: z.union([MakerNameSchema, z.array(MakerNameSchema).min(1)]).optional()`, where `MakerNameSchema = z.string().regex(MAKER_NAME_PATTERN)`. Reject duplicate names in one list with a refine ("maker list repeats '<name>'").
  - JSON schema (`schemas/decision-catalog.schema.json:20,215`): `oneOf` string-with-pattern / array (`minItems: 1`, `uniqueItems: true`, items with pattern). Keep the description text; append "or an ordered fallback list (ADR-040)".
  - `src/catalog.ts:356` copies `raw.maker` unchanged.
- [x] R3. Load checks (`hub.ts:184-215`): `defaults.maker` and each decision's `maker` are normalized with a module-private `toChain(ref: MakerRef): readonly string[]`; **every** name must be registered, else the existing `DecisionCatalogError` (same `field: 'maker'`) naming the first unregistered name. All-or-nothing staging is unchanged.
- [x] R4. `DecideOptions.maker` (`hub.ts:101`) becomes `MakerRef`. Before any backend call: an empty array, a duplicate, or any unregistered name throws `UnknownDecisionMakerError` (empty/duplicate: name `''` / the duplicate, message says why). Hub `defaultMaker` stays a single string.
- [x] R5. `decide` (`hub.ts:262-341`): extract the current single-maker body (resolve → ask → validate → type check → confidence gate → result/fallback) into `private async askOne(makerName, definition, defaults, request, start): Promise<{ result: DecisionResult; failed: boolean }>` — `failed` is true exactly for `no-backend`/`timeout`/`error`. `decide` loops the chain: stop at the first `failed === false`; otherwise continue. After exhaustion return the last failed result (declared fallback, last reason/maker/error). Re-stamp `durationMs` to cover the whole call.
- [x] R6. `attempts`: add `export interface DecisionAttempt { readonly maker: string; readonly reason: DecisionResultBase['reason']; readonly durationMs: number; readonly error?: DecisionErrorInfo }` and `readonly attempts?: readonly DecisionAttempt[]` on `DecisionResultBase`. Set iff the chain tried more than one maker; each attempt's `durationMs` is its own.
- [x] R7. Descriptor (`hub.ts:83`, `describe` at `:236-251`): keep `maker: string` = first name of the effective chain; add `readonly makers: readonly string[]` = full effective chain. `effectiveMakerName` (`:345`) becomes `effectiveChain(...)`; `maker = chain[0]`.
- [x] R8. Tests in `packages/ai-decision/tests/hub.test.ts` (+ `schema.test.ts`, `catalog.test.ts` for R2): failure modes 1–10 in Design, recorded via `decideAndRecord`; regenerate `tests/output/hub-e2e-transcript.json` (only new cases may appear; existing entries must be byte-identical — proves feature R6 for chains).
- [x] R9. Docs:
  - `docs/design/ai-decision-catalog.md` field reference (`:91,105`): `maker` type "maker name or non-empty list".
  - Mark § Maker chains as implemented for the chain part.
  - `packages/ai-decision/README.md`: a "Maker chains" subsection under DecisionHub with a two-line YAML example and the advance rule.
  - `CHANGELOG.md`: note that `DecisionDefinition.maker` / `CatalogDefaults.maker` widen to `MakerRef` (type-level change for code that reads catalogs directly; `describe().maker` stays `string`).

### Acceptance Criteria

- [x] AC1 — A maker chain advances only on backend failure
- [x] AC2 — An exhausted chain returns the declared fallback with the last failure
- [x] AC3 — Chains are validated like single names

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

| File | Lines | Change |
| --- | --- | --- |
| `packages/ai-decision/src/types.ts` | 47-57 | New `export type MakerRef = string \| readonly string[]`; `DecisionDefinition.maker` and `CatalogDefaults.maker` widen to it. The authored form is preserved, so a single-name catalog round-trips unchanged. |
| `packages/ai-decision/src/schema.ts` | 16-38, 74, 86 | `MakerRefSchema`: a name, or an array of names (`min(1)`) whose duplicates are rejected by `superRefine` with `maker list repeats '<name>'`. Used by both the decision and the `defaults` schema. |
| `packages/ai-decision/schemas/decision-catalog.schema.json` | 20-33, 224-237 | `maker` is `oneOf` string-with-pattern / array (`minItems: 1`, `uniqueItems: true`, item pattern); descriptions note the ordered fallback list and the four built-ins. |
| `packages/ai-decision/src/hub.ts` | 71-95 | New `DecisionAttempt { maker, reason, durationMs, error? }` and `DecisionResultBase.attempts?: readonly DecisionAttempt[]`, documented as present only when more than one maker ran. |
| `packages/ai-decision/src/hub.ts` | 120-127 | `DecisionDescriptor.makers: readonly string[]` (the full effective chain) beside `maker` (its first name). |
| `packages/ai-decision/src/hub.ts` | 140-180 | `DecideOptions.maker` becomes `MakerRef`; module-private `toChain` normalizes it and rejects an empty or repeated chain with `UnknownDecisionMakerError`, plus an `AskRequest` type for the one-question request. |
| `packages/ai-decision/src/hub.ts` | 249-290 | `load` validates every name of `defaults.maker` and each decision's `maker` through `toChain`, keeping the same `DecisionCatalogError` (`field: 'maker'`, first unregistered name) and the all-or-nothing staging. |
| `packages/ai-decision/src/hub.ts` | 305-320, 484-490 | `effectiveMakerName` became `effectiveChain`; `describe` reports `makers` with `maker = chain[0]`. |
| `packages/ai-decision/src/hub.ts` | 340-400 | `decide` resolves the chain (per call → decision → defaults → hub default), validates every name before any backend call, then loops `askOne` and stops at the first non-failed outcome; the final result is the last one with `durationMs` restamped to the whole call and `attempts` only when more than one maker ran. |
| `packages/ai-decision/src/hub.ts` | 402-482 | The single-maker body moved verbatim into `private async askOne(...)` returning `{ result, failed }`, where `failed` is exactly `no-backend`/`timeout`/`error`. No change to the reason mapping, the validator call, the synthesized error or the catch. |
| `packages/ai-decision/tests/hub.test.ts` | 1330-1520 | New `describe('maker fallback chains (ADR-040)')` covering failure modes 1-6, 9 and 10: advance past a throwing factory (with `attempts`), low-confidence stops the chain (second factory never runs), exhausted chain returns the last failure, timeout then invalid answer, single-name result carries no `attempts`, unregistered catalog name rejected at load, per-call chain validated before any ask, `describe().makers`. |
| `packages/ai-decision/tests/schema.test.ts` | 118-140 | String and list both parse with the authored form preserved; empty list and repeated names rejected (the refine names the duplicate); a bad element still fails the pattern. |
| `packages/ai-decision/tests/output/hub-e2e-transcript.json` | — | Regenerated: five new `chain:` cases appended, **zero** existing entries changed or removed — the feature-R6 proof that single-name decisions are byte-identical. |
| `packages/ai-decision/README.md` | 113-133 | New "Maker chains" subsection: the two-line YAML example, the advance rule, the exhaustion result with `attempts`, and `describe().makers`. |
| `docs/design/ai-decision-catalog.md` | 105, 331-333 | The `maker` field reference accepts a non-empty ordered list; § Maker chains, shadow and diagnostics records that the chain part is built. |
| `CHANGELOG.md` | 13-22 | Feature-O2 entry: the `maker` widening to `MakerRef` (type-level for direct catalog readers), the advance rule, and the unchanged single-name behaviour. |

The chain reuses the single-maker body unchanged, so there is exactly one place where a reason is mapped and one place where an error is captured. `low-confidence` deliberately does not advance: sampled makers' confidence is a unanimity vote, so a cascade would mostly measure sample agreement (deferred in ADR-040). Makers after the answering one are never resolved, which the factory-spy test pins — lazy factories stay unbuilt.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `MakerRef` at `packages/ai-decision/src/types.ts:56`, applied to `DecisionDefinition.maker` and `CatalogDefaults.maker`; the string case is preserved by the loader (`packages/ai-decision/src/catalog.ts:355`), asserted at `packages/ai-decision/tests/schema.test.ts:120-126`. |
| R2 | MET | `MakerRefSchema` (union of a name / a non-empty distinct-name array) at `packages/ai-decision/src/schema.ts:19-38`, used at `:74` and `:86`; JSON schema `oneOf` at `packages/ai-decision/schemas/decision-catalog.schema.json:20-33` and `:224-237`. The duplicate refine names the offender, asserted at `packages/ai-decision/tests/schema.test.ts:128-136`. |
| R3 | MET | `toChain` at `packages/ai-decision/src/hub.ts:161-179`; `load` checks every name of `defaults.maker` and each decision's `maker` at `:249-290`, keeping the same `DecisionCatalogError` and `field: 'maker'`; all-or-nothing staging untouched. |
| R4 | MET | `DecideOptions.maker?: MakerRef` at `packages/ai-decision/src/hub.ts:140-148`; `decide` validates the whole chain before any backend call at `:346-357`, with `toChain` rejecting empty and repeated chains — asserted at `packages/ai-decision/tests/hub.test.ts:1490-1503` with a request spy at zero. |
| R5 | MET | The single-maker body moved verbatim into `askOne` at `packages/ai-decision/src/hub.ts:402-482` returning `{ result, failed }`; the loop at `:359-380` stops at the first non-failed outcome and otherwise returns the last failure with `durationMs` restamped. |
| R6 | MET | `DecisionAttempt` at `packages/ai-decision/src/hub.ts:73-79` and `attempts?` on the base at `:94`; populated per maker at `:366-374` and attached only when more than one ran at `:386`. |
| R7 | MET | `DecisionDescriptor.makers` at `packages/ai-decision/src/hub.ts:126`; `effectiveChain` at `:484-490`; `describe` reports `maker = chain[0]` at `:316-320`, asserted at `packages/ai-decision/tests/hub.test.ts:1505-1515`. |
| R8 | MET | Chain cases at `packages/ai-decision/tests/hub.test.ts:1330-1520` (failure modes 1-6, 9, 10) recorded through `decideAndRecord`; the regenerated `packages/ai-decision/tests/output/hub-e2e-transcript.json` gained exactly five `chain:` cases with zero existing entries changed or removed. |
| R9 | MET | README "Maker chains" at `packages/ai-decision/README.md:113-133`; field reference and the built-status line at `docs/design/ai-decision-catalog.md:105` and `:331-333`; the `MakerRef` widening note at `CHANGELOG.md:13-22`. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC1 — A maker chain advances only on backend failure | MET | test | failure modes 1-4 at `packages/ai-decision/tests/hub.test.ts:1381-1470`, including the factory-spy assertion that a `low-confidence` answer leaves the second maker unbuilt. |
| AC2 — An exhausted chain returns the declared fallback with the last failure | MET | test | `packages/ai-decision/tests/hub.test.ts:1424-1446` asserts the fallback value, `reason: 'error'`, `maker: 'b'`, the last `error`, and `attempts` in order. |
| AC3 — Chains are validated like single names | MET | test | `packages/ai-decision/tests/hub.test.ts:1472-1503` (catalog chain with an unregistered name at load, per-call chain before any ask) and `packages/ai-decision/tests/schema.test.ts:128-140` (empty list, repeated name, bad element). |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

**Scope.** The 0118 diff on `sp/runall-o2-a2cf`: `MakerRef` through the types, zod and JSON schema; the
chain-aware load checks; `askOne` extracted from the single-maker body with the chain loop, `attempts`
and `describe().makers`; two test files; the regenerated hub transcript; README, design doc and
CHANGELOG. `bun run spur-check` (3097 pass / 0 fail, 62 pre + 5 post rules, fixtures 52/52) and
`bun run build` (12/12 packages) were re-run on the final tree.

**Functional traceability.** R1-R9 MET, each row carrying a `path:line` anchor in the run's review
answer (`.spur/run/fae7d0f5-1d64-4778-a289-6760307fa7c6-review-answer.txt`); AC1-AC3 MET with executable
(`test`) evidence. `spur task verdict --from-answer` derives PASS and writes `.spur/run/0118-verdict.json`.

**SECUA.** Security: no new I/O or credential path; a chain name is validated against the same registry
and taxonomy as a single name. Errors: caller errors still throw before any backend call and backend
outcomes still resolve to the declared fallback carrying the last failure. Correctness: the recorded
transcript's 59 existing entries are unchanged, so single-name decisions are byte-identical.
Usability: the README states the advance rule, the exhaustion shape and `describe().makers`.
Architecture: one extraction keeps a single place where a reason is mapped and a single place where an
error is captured.

**Architectural depth.** The chain is a loop over the existing per-maker body, not a second decision
path, so the fallback contract, the validator call and 0117's diagnostics are shared by construction;
`describe().makers` and the loop read the same `effectiveChain`, so discovery and execution cannot drift.

**Findings.**

| Priority | Finding | Location | Disposition |
| --- | --- | --- | --- |
| P4 | `toChain` rejects an empty or repeated chain even though the schema already rejects both in a catalog — a per-call chain never passes through the loader, so it is the only guard for `DecideOptions.maker: []`. | `packages/ai-decision/src/hub.ts:161` | RESOLVED (required for the per-call path) |
| P4 | `describe()` uses the same `effectiveChain` as `decide`, so an unregistered configured maker could not be described — unreachable because `load` rejects that catalog. | `packages/ai-decision/src/hub.ts:484` | RESOLVED (unreachable by construction) |
| P4 | A stray `packages/ai-decision/.spur/` DB (created by an earlier command run inside that directory) was removed before committing. | `packages/ai-decision/.spur/` | RESOLVED (scratch, referenced by nothing) |

Verdict: PASS
Confidence: HIGH

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
- 2026-10-19T21:12:11.233Z todo → wip (system)
- 2026-10-19T21:13:42.234Z wip → testing (system)
- 2026-10-19T21:13:43.392Z testing → done (system)

