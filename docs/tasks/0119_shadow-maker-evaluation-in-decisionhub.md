---
schema_version: 1
name: Shadow maker evaluation in DecisionHub
status: todo
template: feature-impl
created_at: 2026-10-19T18:43:09.964Z
updated_at: "2026-10-19T18:43:16.459Z"
feature_id: O2

dependencies: ["0118"]
---

## 0119. Shadow maker evaluation in DecisionHub

### Background

Implements: R5 — A shadow maker is observed but never served; R6 — Single-maker decisions are unchanged.

Downstream consumers cannot evaluate a candidate maker on live traffic without switching to it: knowledge-kit task 0317 compares `fm-local` against alternatives, and Spur picks makers per decision with no side-by-side evidence. A shadow asks a second maker on the same rendered request and reports its outcome next to the served answer, so consumers log agreement without risking the decision. ADR-040 item 3; design `docs/design/ai-decision-catalog.md` § Maker chains, shadow and diagnostics (algorithm step 5).

### Requirements

- [ ] R1. Catalog: decisions gain optional `shadow` (one maker name, `MAKER_NAME_PATTERN`).
  - `src/types.ts` `DecisionDefinition.shadow?: string`.
  - Zod `DecisionSchema` (`src/schema.ts:~55-66`).
  - JSON schema decision properties (`schemas/decision-catalog.schema.json`, beside `maker` at `:215`).
  - Loader copy in `src/catalog.ts:~356`.
  - **Not** on `defaults` (ADR-040 scopes it to decision and call).
- [ ] R2. Load check (`hub.ts` `load`): an unregistered `shadow` throws `DecisionCatalogError` with `field: 'shadow'`, all-or-nothing as for `maker`.
- [ ] R3. `DecideOptions.shadow?: string` — per call wins over `decision.shadow`. An unregistered per-call shadow throws `UnknownDecisionMakerError` before any backend call.
- [ ] R4. Types in `hub.ts`: `export interface ShadowOutcome { readonly maker: string; readonly value?: string | number | boolean; readonly confidence: number | null; readonly reason: DecisionResultBase['reason']; readonly durationMs: number; readonly error?: DecisionErrorInfo }` and `readonly shadow?: ShadowOutcome` on `DecisionResultBase`.
- [ ] R5. Execution: when an effective shadow exists, `decide` starts `this.askOne(shadowName, …)` (from 0118) on the **same `request` object** at the same time as the primary chain, and awaits both with `Promise.allSettled`.
  - Map the shadow's `DecisionResult` to `ShadowOutcome`. `value` is present only when `source === 'model'` or `reason === 'low-confidence'` — the answer the shadow actually produced — never the declared fallback.
  - A rejected shadow promise maps to `reason: 'error'` with `toErrorInfo`.
- [ ] R6. The served fields `value`, `source`, `reason`, `maker`, `confidence`, `probability`, `attempts`, `error` come only from the primary chain. `durationMs` covers the whole call, including the shadow wait.
- [ ] R7. Descriptor: `DecisionDescriptor.shadow?: string`, the decision's shadow (the per-call shadow is not visible to `describe`).
- [ ] R8. Tests: failure modes 1–8 in Design, in `tests/hub.test.ts` via `decideAndRecord`, plus schema/catalog cases. Regenerate the transcript; existing entries must stay byte-identical, which proves feature R6.
- [ ] R9. Docs:
  - `README.md` "Shadow makers" subsection: YAML example; the cost note (doubles backend calls, latency is the max of the two).
  - `docs/design/ai-decision-catalog.md` field reference row `shadow`; mark § Maker chains, shadow and diagnostics implemented.
  - ADR-040 status line → Accepted with the built date.
  - `spur feature update O2` status follows the pipeline.

### Acceptance Criteria

- [ ] AC1 — A shadow maker is observed but never served
- [ ] AC2 — Single-maker decisions are unchanged

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

**Chosen.** A synchronous, concurrent shadow whose outcome rides on the result. The hub stays stateless and one-shot hosts (Spur CLI) need no flush, which is why no callback or background work exists.

**Rejected.**
- A fire-and-forget shadow with an `onShadow` callback: the promise outlives `decide`, a one-shot CLI exits before it settles, and the hub would need a lifecycle (`settle()`).
- A sampling rate (shadow 10% of calls): consumers can pass `shadow` per call conditionally; the hub needs no RNG.
- A shadow chain (`MakerRef`): an observed comparison needs one named candidate.
- Shadow on `defaults`: a catalog-wide shadow doubles every decision's cost silently.

**Frozen names.** `ShadowOutcome`, `DecisionResultBase.shadow`, `DecisionDefinition.shadow`, `DecideOptions.shadow`, `DecisionDescriptor.shadow`, catalog key `shadow`.

**Invariants.**
- A shadow never changes any served field (R6) and never makes `decide` reject.
- The shadow sees the identical `request` (state, question, model) as the first primary maker.
- No shadow → no `shadow` key; results are byte-identical to before.
- A shadow equal to the answering maker is still asked: no dedupe, so the behaviour is predictable. Document that it doubles the call.

**Failure modes, written before the code:**
1. Primary typesafe accepted, shadow laya-local accepted with a different value → the served value is typesafe's; `shadow.value` is laya's; `shadow.reason` is `accepted`.
2. Shadow rejects `DecisionConfigError` (factory) → `shadow.reason` is `no-backend` with `error`; the served result is unchanged; `decide` resolves.
3. Shadow low-confidence → `shadow.value` present, `reason` `low-confidence`.
4. Shadow fails with a backend error → no `shadow.value`.
5. Primary chain falls back, shadow accepted → the served fallback is unchanged; `shadow` reports the accept.
6. Both asks receive the same request object (spy: `===`, or deep-equal on state/questions/model).
7. Unregistered catalog `shadow` → `DecisionCatalogError` `field: 'shadow'`; unregistered per-call → `UnknownDecisionMakerError`, no `ask` called.
8. Per-call `shadow` overrides `decision.shadow` (spy shows only the per-call maker asked).

**Anti-patterns.** No `await` on the shadow before starting the primary (sequential doubles latency); no try/catch around the primary that swallows its caller errors; no mutation of the shared `request`.

### Plan

1. **Tests first:** failure modes 1–8 in `tests/hub.test.ts`, plus the schema/catalog `shadow` key cases. Run `bun test packages/ai-decision` and confirm the new cases fail.
2. R1–R3: types, schemas, loader, load and per-call checks.
3. R4–R6: shadow execution on `askOne`, then the outcome mapping.
4. R7: descriptor.
5. Run the full package suite, regenerate the transcript, and review its diff: only new cases.
6. Docs and status (R9).
7. Gate: `bun run spur-check && bun run build`. `git status` shows only the files below.

**Files touched:**
- `packages/ai-decision/src/{types.ts, schema.ts, catalog.ts, hub.ts}`
- `packages/ai-decision/schemas/decision-catalog.schema.json`
- `packages/ai-decision/tests/{hub.test.ts, schema.test.ts, catalog.test.ts, output/hub-e2e-transcript.json}`
- `packages/ai-decision/README.md`
- `docs/design/ai-decision-catalog.md`
- `docs/00_ADR.md` (ADR-040 status line only)

**Depends on:** 0118, which provides `askOne`, and edits the same `hub.ts`, schema and transcript files.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- Feature O2; ADR-040; `docs/design/ai-decision-catalog.md` § Maker chains, shadow and diagnostics.
- Downstream candidates: knowledge-kit task 0317 (maker effectiveness), spur-new task 1263 (outcome accuracy report).

**Premises (verified 2026-10-19):**

- `packages/ai-decision/src/schema.ts:55-66` — strict `DecisionSchema`: an unknown `shadow` key is rejected today, so R1 must add it.
- `packages/ai-decision/schemas/decision-catalog.schema.json:215` — the decision `maker` property, beside which `shadow` goes.
- `packages/ai-decision/src/hub.ts:184-215` — the load-check pattern to mirror; `:262` `decide`.
- `askOne` does not exist yet; 0118 R5 creates it (dependency).

### History

- 2026-10-19T18:43:16.459Z backlog → todo (system)

