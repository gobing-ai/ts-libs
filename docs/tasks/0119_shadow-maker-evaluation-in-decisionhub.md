---
schema_version: 1
name: Shadow maker evaluation in DecisionHub
status: done
template: feature-impl
created_at: 2026-10-19T18:43:09.964Z
updated_at: "2026-10-19T21:21:36.604Z"
feature_id: O2

dependencies: ["0118"]
done_forced: "false"
done_reason: unforced close; PASS artifact at .spur/memory/evidence/0119-verdict.json
---

## 0119. Shadow maker evaluation in DecisionHub

### Background

Implements: R5 — A shadow maker is observed but never served; R6 — Single-maker decisions are unchanged.

Downstream consumers cannot evaluate a candidate maker on live traffic without switching to it: knowledge-kit task 0317 compares `fm-local` against alternatives, and Spur picks makers per decision with no side-by-side evidence. A shadow asks a second maker on the same rendered request and reports its outcome next to the served answer, so consumers log agreement without risking the decision. ADR-040 item 3; design `docs/design/ai-decision-catalog.md` § Maker chains, shadow and diagnostics (algorithm step 5).

### Requirements

- [x] R1. Catalog: decisions gain optional `shadow` (one maker name, `MAKER_NAME_PATTERN`).
  - `src/types.ts` `DecisionDefinition.shadow?: string`.
  - Zod `DecisionSchema` (`src/schema.ts:~55-66`).
  - JSON schema decision properties (`schemas/decision-catalog.schema.json`, beside `maker` at `:215`).
  - Loader copy in `src/catalog.ts:~356`.
  - **Not** on `defaults` (ADR-040 scopes it to decision and call).
- [x] R2. Load check (`hub.ts` `load`): an unregistered `shadow` throws `DecisionCatalogError` with `field: 'shadow'`, all-or-nothing as for `maker`.
- [x] R3. `DecideOptions.shadow?: string` — per call wins over `decision.shadow`. An unregistered per-call shadow throws `UnknownDecisionMakerError` before any backend call.
- [x] R4. Types in `hub.ts`: `export interface ShadowOutcome { readonly maker: string; readonly value?: string | number | boolean; readonly confidence: number | null; readonly reason: DecisionResultBase['reason']; readonly durationMs: number; readonly error?: DecisionErrorInfo }` and `readonly shadow?: ShadowOutcome` on `DecisionResultBase`.
- [x] R5. Execution: when an effective shadow exists, `decide` starts `this.askOne(shadowName, …)` (from 0118) on the **same `request` object** at the same time as the primary chain, and awaits both with `Promise.allSettled`.
  - Map the shadow's `DecisionResult` to `ShadowOutcome`. `value` is present only when `source === 'model'` or `reason === 'low-confidence'` — the answer the shadow actually produced — never the declared fallback.
  - A rejected shadow promise maps to `reason: 'error'` with `toErrorInfo`.
- [x] R6. The served fields `value`, `source`, `reason`, `maker`, `confidence`, `probability`, `attempts`, `error` come only from the primary chain. `durationMs` covers the whole call, including the shadow wait.
- [x] R7. Descriptor: `DecisionDescriptor.shadow?: string`, the decision's shadow (the per-call shadow is not visible to `describe`).
- [x] R8. Tests: failure modes 1–8 in Design, in `tests/hub.test.ts` via `decideAndRecord`, plus schema/catalog cases. Regenerate the transcript; existing entries must stay byte-identical, which proves feature R6.
- [x] R9. Docs:
  - `README.md` "Shadow makers" subsection: YAML example; the cost note (doubles backend calls, latency is the max of the two).
  - `docs/design/ai-decision-catalog.md` field reference row `shadow`; mark § Maker chains, shadow and diagnostics implemented.
  - ADR-040 status line → Accepted with the built date.
  - `spur feature update O2` status follows the pipeline.

### Acceptance Criteria

- [x] AC1 — A shadow maker is observed but never served
- [x] AC2 — Single-maker decisions are unchanged

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

| File | Lines | Change |
| --- | --- | --- |
| `packages/ai-decision/src/types.ts` | 48-52 | `DecisionDefinition.shadow?: string` — the decision's shadow maker (a chain or a defaults-level shadow is deliberately absent). |
| `packages/ai-decision/src/schema.ts` | 82 | `shadow: z.string().regex(MAKER_NAME_PATTERN).optional()` on the strict decision schema; `defaults` stays closed, so `defaults.shadow` is rejected. |
| `packages/ai-decision/schemas/decision-catalog.schema.json` | — | Decision `shadow` property (pattern) beside `maker`. |
| `packages/ai-decision/src/catalog.ts` | 357 | The loader copies the authored `shadow` unchanged. |
| `packages/ai-decision/src/hub.ts` | 80-99 | `ShadowOutcome { maker, value?, confidence, reason, durationMs, error? }` and `DecisionResultBase.shadow?`. |
| `packages/ai-decision/src/hub.ts` | 140-150, 165-170 | `DecideOptions.shadow?: string` and `DecisionDescriptor.shadow?: string` (the decision's only — a per-call shadow is invisible to `describe`). |
| `packages/ai-decision/src/hub.ts` | 320-335 | `load` rejects an unregistered `shadow` with `DecisionCatalogError` (`field: 'shadow'`), all-or-nothing as for `maker`. |
| `packages/ai-decision/src/hub.ts` | 380-395 | `decide` validates a per-call shadow against the registry before any backend call (`UnknownDecisionMakerError`). |
| `packages/ai-decision/src/hub.ts` | 415-437 | The shadow is started on the **same `request` object** without being awaited, so it runs concurrently with the primary chain; a rejected ask maps to its own `error` outcome instead of rejecting `decide`. |
| `packages/ai-decision/src/hub.ts` | 455-470 | The served fields come only from the primary chain; `durationMs` covers the whole call including the shadow wait, and `shadow` is attached only when one was named. |
| `packages/ai-decision/src/hub.ts` | 472-490 | `toShadowOutcome` projects the shadow's own result, carrying `value` only when the shadow actually answered — from the answer `askOne` now reports (`answered`), not from the declared fallback a low-confidence result carries. |
| `packages/ai-decision/tests/hub.test.ts` | 1522-1650 | Failure modes 1-8: accepted-beside-accepted, shadow factory throw, low-confidence value, backend error with no value, primary falling back while the shadow accepts, identical request object (`toBe`), unregistered catalog/per-call shadow, per-call override. |
| `packages/ai-decision/tests/schema.test.ts` | 144-158 | A decision accepts one shadow name, `defaults.shadow` is rejected, and a bad name or a list is rejected. |
| `packages/ai-decision/tests/output/hub-e2e-transcript.json` | — | Regenerated: six new `shadow:` cases, zero existing entries changed or removed (the feature-R6 proof). |
| `packages/ai-decision/README.md` | 132-153 | New "Shadow makers" subsection: the YAML example, the served/observed split, and the cost note (doubles backend calls; latency is the slower of the two; no `defaults.shadow`). |
| `docs/design/ai-decision-catalog.md` | 106, 331-332 | `shadow` field-reference row; § Maker chains, shadow and diagnostics marked built. |
| `docs/00_ADR.md` | 832 | ADR-040 status: Accepted with the build date and tasks. |

The shadow reuses `askOne`, so it inherits the same reason mapping, the same validator call and the same caught-error record as the primary. It is fired on the identical request object before the primary chain is awaited, which is what keeps latency at the slower of the two rather than their sum, and `toShadowOutcome` reads the answer `askOne` observed so a low-confidence shadow reports the label it chose instead of the fallback a `low-confidence` result carries.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `DecisionDefinition.shadow?: string` at `packages/ai-decision/src/types.ts:48-52`; the strict decision schema accepts it at `packages/ai-decision/src/schema.ts:82`; the JSON schema documents it beside `maker`; the loader copies it at `packages/ai-decision/src/catalog.ts:357`; `defaults` stays closed (asserted at `packages/ai-decision/tests/schema.test.ts:149-151`). |
| R2 | MET | `load` rejects an unregistered shadow with `DecisionCatalogError` `field: 'shadow'` at `packages/ai-decision/src/hub.ts:320-335`, keeping the all-or-nothing staging; asserted at `packages/ai-decision/tests/hub.test.ts:1616-1630`. |
| R3 | MET | `DecideOptions.shadow?: string` at `packages/ai-decision/src/hub.ts:140-150`; the per-call check throws `UnknownDecisionMakerError` before any ask at `:380-395`, asserted with zero recorded requests at `packages/ai-decision/tests/hub.test.ts:1628-1630`. |
| R4 | MET | `ShadowOutcome` at `packages/ai-decision/src/hub.ts:80-99` and `DecisionResultBase.shadow?` at `:110`. |
| R5 | MET | The shadow is started unawaited on the same `request` object at `packages/ai-decision/src/hub.ts:415-437` and awaited beside the chain at `:463`; the mapping at `:472-490` carries `value` only when the shadow answered, sourced from the answer `askOne` observed, and a rejected ask maps to `reason: 'error'` with `toErrorInfo`. |
| R6 | MET | The served fields are built by the chain alone (`packages/ai-decision/src/hub.ts:455-470`); `durationMs` is restamped over the whole call; the regenerated transcript's 64 existing entries are unchanged. |
| R7 | MET | `DecisionDescriptor.shadow?: string` at `packages/ai-decision/src/hub.ts:165-170`, populated from the decision only at `:340`, asserted at `packages/ai-decision/tests/hub.test.ts:1640-1650`. |
| R8 | MET | Failure modes 1-8 at `packages/ai-decision/tests/hub.test.ts:1522-1650` recorded through `decideAndRecord`, plus the schema cases at `packages/ai-decision/tests/schema.test.ts:144-158`; the regenerated `packages/ai-decision/tests/output/hub-e2e-transcript.json` gained six `shadow:` cases with zero existing entries changed. |
| R9 | MET | README "Shadow makers" at `packages/ai-decision/README.md:132-153`; the `shadow` field row and built status at `docs/design/ai-decision-catalog.md:106` and `:331-332`; ADR-040 Accepted with the build date at `docs/00_ADR.md:832`. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC1 — A shadow maker is observed but never served | MET | test | `packages/ai-decision/tests/hub.test.ts:1544-1566` (the served value is the primary's while `shadow.value` is the shadow's) and `:1596-1615` (a falling-back primary still serves its fallback while the shadow reports its accept). |
| AC2 — Single-maker decisions are unchanged | MET | command | the regenerated `packages/ai-decision/tests/output/hub-e2e-transcript.json` keeps all 64 pre-existing entries byte-identical (only the six `shadow:` cases were appended), and `bun test packages/ai-decision/tests/hub.test.ts` passes 60 cases. |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

**Scope.** The 0119 diff on `sp/runall-o2-a2cf`: the `shadow` key through types, zod, the JSON schema and
the loader; the load and per-call registration checks; the concurrent `ShadowOutcome` execution on
`askOne`; two test files; the regenerated hub transcript; README, design doc and the ADR-040 status.
`bun run spur-check` (3107 pass / 0 fail, 62 pre + 5 post rules, fixtures 52/52) and `bun run build`
(12/12 packages) were re-run on the final tree.

**Functional traceability.** R1-R9 MET, each row carrying a `path:line` anchor in the run's review
answer (`.spur/run/a7877ed3-4540-4781-8989-7591febb97f3-review-answer.txt`); AC1-AC2 MET with executable
evidence. `spur task verdict --from-answer` derives PASS and writes `.spur/run/0119-verdict.json`.

**SECUA.** Security: no new I/O or credential path, and the shadow's failure record is the same capped
`{ name, message }`. Errors: a throwing factory, backend error or timeout lands on `shadow.reason`/
`shadow.error` while the served result is untouched, so the shadow never rejects `decide`; an
unregistered per-call shadow is a caller error thrown before any ask. Correctness: the shadow sees the
identical request object, starts before the primary is awaited, and its `value` comes from the answer it
produced rather than the fallback a low-confidence result carries. Usability: the README states the
example, the served/observed split and the doubled-call cost. Architecture: no callback, queue or
lifecycle — the outcome rides the result the caller already receives, which is what makes a one-shot CLI
host safe.

**Architectural depth.** `toShadowOutcome` projects the same `askOne` outcome the chain uses, so the
shadow inherits the reason mapping, the validator and the diagnostics for free; `askOne` reporting the
answer it observed is the one addition that lets a low-confidence shadow state its own label without
duplicating that mapping.

**Findings.**

| Priority | Finding | Location | Disposition |
| --- | --- | --- | --- |
| P4 | `ShadowOutcome.durationMs` measures the shadow's own ask while the served `durationMs` covers the whole call — deliberate, so a shadow's cost is visible. | `packages/ai-decision/src/hub.ts:472` | RESOLVED (intended asymmetry) |
| P4 | A shadow equal to the answering maker is still asked (no dedupe), doubling that call; documented rather than special-cased so behaviour stays predictable. | `packages/ai-decision/src/hub.ts:415` | RESOLVED (documented) |
| P4 | `askOne` gained an internal optional `answered` field so a low-confidence shadow can report its own value; it changes no served field. | `packages/ai-decision/src/hub.ts:402` | RESOLVED (internal only) |

Verdict: PASS
Confidence: HIGH

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
- 2026-10-19T21:20:02.766Z todo → wip (system)
- 2026-10-19T21:21:35.407Z wip → testing (system)
- 2026-10-19T21:21:36.599Z testing → done (system)

