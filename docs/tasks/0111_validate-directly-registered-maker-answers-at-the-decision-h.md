---
schema_version: 1
name: Validate directly registered maker answers at the decision hub boundary
status: done
template: feature-impl
created_at: 2026-10-12T07:17:18.105Z
updated_at: "2026-10-12T18:56:06.203Z"
feature_id: N1

priority: P2
ac_numbering: task-local
ac_altitude: task-local
estimate_hours: 3
done_forced: "false"
done_reason: unforced close; PASS artifact at .spur/memory/evidence/0111-verdict.json
---

## 0111. Validate directly registered maker answers at the decision hub boundary

### Background

The 2026-10-12 inline review confirmed that directly registered custom DecisionMakers bypass the answer validator used by createDecisionMaker. packages/ai-decision/src/registry.ts:56 accepts a DecisionMaker or factory, but packages/ai-decision/src/hub.ts:291 checks only answer presence/kind before applying the confidence threshold. A choice answer with label 'undeclared', confidence NaN and probabilities {} is accepted with source:model; NaN is not less than the threshold. The reproduction in /tmp/ts-libs-review-hub-repro.ts constructs the actual registry and hub and loads a YAML catalog with yes/no criteria and fallback no. Built-in and createDecisionMaker-wrapped makers already validate through packages/ai-runner/src/decision/decision-maker.ts:193. Feature N promises fallback on invalid answers for consumer-registered makers. Direct triage fixes already address unrelated strict-glob and event-log directory defects. Task 0106 is cancelled and excluded arbitrary custom maker contracts; it does not own this repair. Preserve the valid fractional expected-score behavior it explicitly records.

**Refine corrections (2026-10-12)**
- Wrapped-maker validation was generalized to built-ins → createDecisionMaker validates but direct registry objects need not → freeze hub validation for every resolved maker without changing registry registration.
- Malformed-response coverage left distributions implicit → shared validateAnswers checks exact probability keys, finite bounded values, normalized mass and score legend → explicitly test these shared semantics at the direct-maker boundary.
- Custom-maker double shape was unspecified → existing ask is generic and convenience methods are part of DecisionMaker → implement a typed test helper, keeping malformed payload casts confined to test input.

### Requirements

- [x] R1. Validate answers from every resolved maker against the rendered request questions inside DecisionHub.decide before confidence evaluation, reusing the public validateAnswers validator from ts-ai-runner.
- [x] R2. Map malformed answers to the existing declared fallback with source:default, reason:error and confidence:null; preserve existing maker selection, caller-error throwing and backend-error mapping.
- [x] R3. Add hub tests using directly registered custom makers for invalid labels, non-finite/out-of-range confidence, missing/extra answers and invalid score/noul values, while retaining valid custom answers and fractional expected scores; run both repository gates.

### Acceptance Criteria

- [x] AC1 — Every maker's answer crosses validation (req: R1)
  Given a directly registered custom maker returning an undeclared choice label or NaN/infinite/out-of-range confidence, when decide is called on a valid catalog decision, then the answer is rejected before confidence gating and the declared fallback is returned.
- [x] AC2 — Fallback and caller errors remain distinct (req: R2)
  Given malformed backend answers, when decide resolves, then source is default, reason is error, confidence is null and maker identifies the selected maker; unknown decisions, invalid inputs and unregistered per-call makers still throw before any maker ask.
- [x] AC3 — Correspondence and valid values remain compatible (req: R3)
  Given missing/extra keys, invalid score bounds or noul probability, when a direct custom maker answers, then it falls back; valid choice, valid fractional expected-score and valid noul answers remain accepted, and focused hub tests, bun run spur-check and bun run build exit 0.

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-10-12T16:15:31.451Z

Q: Does this alter custom maker contracts? A: It enforces the existing answer schema at the hub boundary, as Feature N1 requires; direct registration remains supported. validateAnswers is already publicly exported by ts-ai-runner.

Q: Which policies remain? A: Reuse exact existing validation, including distribution tolerance and fractional scores. No argmax/calibration or new timeout/cancellation policy. Existing invalid caller input still throws outside the fallback boundary.

Q: Is cancelled 0106 a prerequisite? A: No. It does not own arbitrary custom maker validation; no unfinished upstream work is needed.

### Design

Import validateAnswers from the existing public ts-ai-runner barrel and call validateAnswers(request.questions, answers) immediately after await maker.ask(request), inside the existing try/catch in DecisionHub.decide. Its DecisionBackendError follows the existing reason:error fallback path with null confidence. Keep the current presence/kind guard if useful for typed indexing; add no new error type, adapter, registry wrapper or API. Targets: packages/ai-decision/src/hub.ts and packages/ai-decision/tests/hub.test.ts. Tests must register a direct DecisionMaker test double (rather than createDecisionMaker around a driver), because the latter already validates and masks this gap. Use a typed helper implementing the existing maker interface for scripted asks and unused convenience methods. Reuse shared validation semantics, including normalized distributions and permitted fractional expected scores; do not add argmax or calibration policy. Reject per-type hub validators and registry wrappers because they duplicate the shared boundary or alter maker identity/lifecycle. Out of scope: cancelling hung makers, timeouts, maker disposal concurrency, catalog/API/schema/dependency changes.

No new API. Validation executes after ask resolves with inAsk=true, so DecisionBackendError maps to reason:error, never no-backend. Keep caller validation and maker selection before this try/catch. Test exact answer-name matching (missing/extra), wrong kind, null/malformed payload, probability keys/non-finite values/mass outside the validator's existing 1e-6 tolerance, score bounds/legend and noul probability; use valid request-derived question IDs. Preserve the validator's fractional score acceptance and existing noul confidence/value calculation. Do not strengthen the common validator or require score=distribution expectation. Retain existing low-confidence, construction/timeout and caller-error tests. Current registry and wrapper callers require no edits; direct maker regression tests bypass createDecisionMaker. No task dependencies, extra worktrees or active wip owners at refinement.

### Plan

- [x] 1. Add a direct custom maker hub regression for undeclared labels and NaN confidence; demonstrate it fails before the change (R1, R3).
- [x] 2. Invoke the shared public answer validator inside the hub's existing fallback try/catch (R1, R2).
- [x] 3. Cover malformed correspondence and all three answer kinds, probability keys/mass and score legends, valid fractional scores, and existing caller-error behavior (R2, R3).
- [x] 4. Run bun test packages/ai-decision/tests/hub.test.ts, bun run spur-check and bun run build; inspect intentional status (R3).

### Solution

Directly registered makers now cross the same shared answer validator that `createDecisionMaker` applies, so an undeclared label, a NaN confidence or unnormalized probabilities resolves to the declared fallback instead of being accepted as `source: model`. No new API, error type, registry wrapper or dependency — one call inside the hub's existing try/catch, plus the direct-maker regression suite that pins the boundary.

| Change | Anchor (one file:line) |
| --- | --- |
| Import the public `validateAnswers` from the `@gobing-ai/ts-ai-runner` barrel already depended on | packages/ai-decision/src/hub.ts:9 |
| Validate every resolved maker's answers immediately after `await maker.ask(request)`, inside the existing fallback try/catch, so `DecisionBackendError` maps to `reason: error` with `confidence: null` | packages/ai-decision/src/hub.ts:296 |
| Typed direct `DecisionMaker` double (registered as a maker object, never wrapped by `createDecisionMaker`, which would mask the gap) with scripted `ask` and the unused sugar methods | packages/ai-decision/tests/hub.test.ts:97 |
| Inline catalog with one decision per answer kind at floor 0.5, so only answer validation can reject a scripted answer | packages/ai-decision/tests/hub.test.ts:129 |
| `directHub` helper registering the double directly into a builtins-free registry | packages/ai-decision/tests/hub.test.ts:152 |
| AC1 regression: undeclared label and NaN confidence fall back before confidence gating | packages/ai-decision/tests/hub.test.ts:1004 |
| AC1: non-finite and out-of-range confidence is rejected | packages/ai-decision/tests/hub.test.ts:1037 |
| AC2/AC3: missing, surplus and null answer payloads are rejected | packages/ai-decision/tests/hub.test.ts:1054 |
| AC2: a wrong answer kind is rejected | packages/ai-decision/tests/hub.test.ts:1085 |
| AC3: probability keys, non-finite values and mass outside the existing 1e-6 tolerance are rejected, mass inside it stays accepted | packages/ai-decision/tests/hub.test.ts:1098 |
| AC3: score bounds and legend are validated | packages/ai-decision/tests/hub.test.ts:1129 |
| AC3: noul probability out of range or non-finite is rejected | packages/ai-decision/tests/hub.test.ts:1151 |
| AC3: valid choice, valid fractional expected score and valid noul answers stay accepted | packages/ai-decision/tests/hub.test.ts:1170 |
| AC2: unknown id, invalid input and unregistered per-call maker still throw before any ask | packages/ai-decision/tests/hub.test.ts:1212 |
| Repeatable e2e artifact now records every direct-maker case and its fallback envelope | packages/ai-decision/tests/output/hub-e2e-transcript.json:273 |

Retained unchanged: maker selection and caller-error throwing before the try/catch, the presence/kind guard used for typed indexing, the shared validator's semantics (fractional expected scores, per-level legend, normalized mass) and the existing low-confidence, construction/timeout and caller-error tests.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | The hub now calls the shared public validateAnswers (`packages/ai-decision/src/hub.ts:296`, implementation `packages/ai-runner/src/decision/validation.ts:73`) on the map returned by the single ask (`packages/ai-decision/src/hub.ts:292`) that every resolved maker passes through (`packages/ai-decision/src/hub.ts:290` registry resolve), before the confidence gate (`packages/ai-decision/src/hub.ts:302`). I reproduced this with my own throwaway harness (a real DecisionHub constructed in /tmp/0111-verify/probe.test.ts over a directly registered custom DecisionMaker double, never wrapped by createDecisionMaker, against an independent inline YAML catalog): 15 malformed payloads each reached source default, reason error, confidence null, maker custom; an undeclared label carrying a below-floor confidence of 0.1 resolved to reason error with confidence null, while the same below-floor confidence with a valid label resolved to reason low-confidence, proving validation runs before confidence evaluation. |
| R2 | MET | validateAnswers throws DecisionBackendError inside the pre-existing try block whose catch is `packages/ai-decision/src/hub.ts:333`, with inAsk already true, so the malformed-answer path reuses the existing declared fallback builder (`packages/ai-decision/src/hub.ts:299`, `packages/ai-decision/src/hub.ts:366`) and can never become reason no-backend. My harness observed the preserved mapping directly: ask throwing DecisionBackendError gives source default, reason error, confidence null, maker custom; ask throwing DecisionTimeoutError gives reason timeout; a maker factory throwing gives reason no-backend; all with source default. Maker selection and caller-error throwing are untouched before the try (`packages/ai-decision/src/hub.ts:264`, `packages/ai-decision/src/hub.ts:265`, `packages/ai-decision/src/hub.ts:268`): my harness observed UnknownDecisionError for an unknown id, DecisionInputError for a missing required parameter and UnknownDecisionMakerError for an unregistered per-call maker, each with zero asks recorded, matching `packages/ai-decision/tests/hub.test.ts:1212`. |
| R3 | MET | Nine new direct-maker tests back the boundary: `packages/ai-decision/tests/hub.test.ts:1004`, `packages/ai-decision/tests/hub.test.ts:1037`, `packages/ai-decision/tests/hub.test.ts:1054`, `packages/ai-decision/tests/hub.test.ts:1085`, `packages/ai-decision/tests/hub.test.ts:1098`, `packages/ai-decision/tests/hub.test.ts:1129`, `packages/ai-decision/tests/hub.test.ts:1151`, `packages/ai-decision/tests/hub.test.ts:1170`, `packages/ai-decision/tests/hub.test.ts:1212`. The test-file diff is +315/-0, so no pre-existing expectation was relaxed, and the shared validator file is unmodified, so the fractional expected score, per-level legend and 1e-6 mass tolerance are exactly as before. The compatibility half was reproduced independently in my harness rather than credited from test names: a valid choice gives source model value alpha confidence 0.9; a fractional expected score of 1.5 on a 3-level rubric gives source model value 1.5; a valid noul of 0.9 gives source model value true probability 0.9; a distribution 5e-7 off mass 1 (inside the pre-existing tolerance) gives source model. Gates on the current bytes: focused suite 36 pass / 0 fail / 143 expect() calls, bun run spur-check exit 0 with 2991 pass / 0 fail and both rule presets clean, bun run build exit 0 for every package. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC1 — Every maker's answer crosses validation (req: R1) | MET | test | Falsification observed by me, not inherited: I copied the hub source to /tmp and deleted only the validateAnswers call, leaving everything else byte-identical (no repo edit), then drove both copies through the same directly registered double and catalog. With the call removed, the payload choice label gamma / confidence NaN / probabilities empty resolves to source model, reason accepted, value gamma, and Number.isNaN on the returned confidence is true; the tree version resolves the same payload to source default, reason error, confidence null, value beta, maker custom. The same split holds for confidence Infinity, 1.5 and -0.1, for probabilities of mass 0.7, for a surplus answer key and for a noul probability of 1.5 — each accepted with source model before the change and each falling back after it. That is the required "falls back now where it was previously accepted" direction, and it is also the pre-change failure the new tests at `packages/ai-decision/tests/hub.test.ts:1004` and `packages/ai-decision/tests/hub.test.ts:1037` pin, with the ask count asserted at 1 so no maker was skipped. |
| AC2 — Fallback and caller errors remain distinct (req: R2) | MET | test | Fallback envelope under malformed answers, observed in my harness for every case including the declared fallback value: source default, reason error, confidence null, and maker naming the selected maker (custom); the noul fallback additionally reports probability null. Backend-error mapping is preserved rather than replaced: DecisionBackendError from ask gives reason error, DecisionTimeoutError gives reason timeout, a throwing maker factory gives reason no-backend, all with source default and the maker named — none of these collapses into the malformed-answer path. Caller errors still throw before any ask: unknown decision id, invalid caller input and unregistered per-call maker each threw the typed hub error with zero asks recorded (`packages/ai-decision/tests/hub.test.ts:1212` asserts the same with an explicit zero-length ask list), and the caller guards sit before the try at `packages/ai-decision/src/hub.ts:264`, `packages/ai-decision/src/hub.ts:265`, `packages/ai-decision/src/hub.ts:268`. |
| AC3 — Correspondence and valid values remain compatible (req: R3) | MET | test | Rejection half, all observed in my harness: missing answer key, surplus answer key, null payload, wrong kind, undeclared label, wrong probability key set, non-finite probability, mass 0.7 and mass 1+5e-6, score above the rubric, negative score, missing legend level and noul probability 1.5 / -0.5 / NaN each resolve to source default, reason error, confidence null. Acceptance half, also observed there: valid choice accepted with source model and value alpha; valid fractional expected score 1.5 accepted with source model and value 1.5; valid noul 0.9 accepted with source model, value true and probability 0.9; a distribution 5e-7 off mass 1 stays accepted, so the fix did not overshoot the pre-existing 1e-6 tolerance. The criterion's three gates pass on the current bytes: bun test packages/ai-decision/tests/hub.test.ts gives 36 pass / 0 fail / 143 expect() calls; bun run spur-check exits 0 with 2991 pass / 0 fail, 62 rules passed pre-test and 3 rules plus 23/23 rule fixtures post-test; bun run build exits 0 for all 13 packages. The tracked e2e transcript was regenerated byte-identically by those runs (sha256 0a5961aa before and after my suite run), so the artifact in the diff is reproducible rather than hand-edited. |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

| Priority | Anchor | Finding | Disposition |
| --- | --- | --- | --- |
| P1 (blocker) | — | none | — |
| P2 (major) | — | none | — |
| P3 (minor) | — | none | — |
| P4 (advisory) | packages/ai-decision/tests/output/hub-e2e-transcript.json:273 | `hub.test.ts` regenerates this tracked artifact from every accumulated case, so the diff is a required, byte-reproducible consequence of the new tests, not scope creep — it must stay in the change; note that a run whose suite fails would leave it truncated (only 123 of 290 added lines). | DEFER |

**Verdict: PASS** — R1–R3 implemented and traceable; AC1–AC3 honestly satisfied; no P1–P3 finding.

**P1/P2/P3 clean — why.** The reviewed diff is `packages/ai-decision/src/hub.ts` +5 lines (import `validateAnswers` from the already-depended `@gobing-ai/ts-ai-runner` barrel at :9 and the call at :296), `tests/hub.test.ts` +315 lines, and the regenerated transcript. `packages/ai-decision/src/hub.ts:296` sits inside the *existing* try/catch, after `inAsk = true` (:292) and after `await maker.ask(request)` (:293), so a `DecisionBackendError` from `validateAnswers` reaches the `catch` with `inAsk === true` and maps to `reason: error` with `confidence: null`; it can never become `no-backend`. `mustGet`, `resolveDecisionInput` and the `registry.has` maker-selection check all still precede the try block (:269–:280), so caller errors keep throwing before any ask. The shared validator is reused verbatim (`packages/ai-runner/src/decision/validation.ts:73`), no reimplementation, no new error type, no registry wrapper, no hub-local per-type validator, no export/API change (`src/index.ts` untouched) and no dependency or `deps`/`paths` change. The test double is registered as a maker **object** into a `builtins: false` registry (`hub.test.ts:152`), never through `createDecisionMaker` (:97 comment records why), so the hub is the only validator in the loop — the gap is not masked.

**R → implementation → test traceability.** R1 → `hub.ts:296`, proven by the new suite. R2 → the existing `fallbackResult(definition, makerName, 'error', null, start)` path (:298) plus retained pre-try/catch throwing, covered by `hub.test.ts:1054` (missing/surplus/null), `:1085` (wrong kind), `:1151` (noul) and `:1212` (unknown id, invalid input, unregistered per-call maker — with `expect(maker.requests).toHaveLength(0)`). R3 → `:1004`, `:1037`, `:1098`, `:1129`, `:1170`. AC3 correspondence holds: validator-internal changes are absent (`validation.ts` untouched, so the fractional expected score, per-level legend and `1e-6` mass tolerance are exactly as before), and `hub.test.ts:1170` pins the accepted fractional score (`1.5`) and valid choice/noul envelopes.

**Independent evidence.**
- `bun test packages/ai-decision/tests/hub.test.ts` → `36 pass / 0 fail / 143 expect() calls`. Pre-existing count 27, so the 9 new tests are additive; nothing was skipped or `.skip`'d.
- Gate receipt `.spur/run/0111-check-receipt.json`: `status PASS`, `inputDigest sha256:0b31bd03…`; `.spur/run/0111-test-gate.log` ends `2991 pass / 0 fail` with both `spur rule` presets clean. I did not re-run `spur-check` (pipeline test hop owns it).
- AC3's second gate, checked directly: `bun run build` → `build_exit=0`, all 12 packages `Exited with code 0`.
- `git status --porcelain` → exactly the 4 expected paths; no `.skip`, no `biome-ignore`, no workflow or config edits.

**Mutations (2 structural + 8 adversarial, all caught; none survived).**
1. *Removed the fix* (temporarily commented out `hub.ts:296`) and re-ran the suite: `30 pass / 6 fail` — the undeclared-label/NaN-confidence, confidence-range, correspondence, probability-mass, score-legend and noul cases fail without the change. The 3 that still pass pre-change (wrong kind, valid answers, caller errors) are retained-compatibility tests, as intended. Source restored byte-identically (`hub.ts` sha256 `c9a85ef7…` before and after).
2. *Throwaway direct-maker probe* (`.spur/run/adv-0111.test.ts`, gitignored scratch, not part of the suite): 7/7 pass. B1 a well-formed answer for a *different real catalog decision id* (`grade` answer while `pick` is asked) → fallback `error`, so the exact-answer-name check bites; B2 `confidence` `Infinity`/`-1`/`NaN` → `error`; B3 mass `5e-6` off → `error`, `1e-7` off → `accepted` (tolerance preserved); B4 `noul` without a probability → `error` (not `low-confidence`); B5 a maker throwing a plain `Error` → `reason: error`, not `no-backend`; B6 `null`/array answers → `error` and an unregistered per-call maker throws before any ask; B7 valid fractional score `0.5` → `accepted`. My first B3 expectation used a nominal exactly-`1e-6` offset and failed: `Math.abs(0.9 + (0.1 + 1e-6) - 1) = 1.000000000139778e-6 > 1e-6`. That is float representation in the pre-existing shared tolerance, not a defect of this change; the implementer's test correctly used `5e-7`.

**Scope question — the transcript artifact (judged, not inherited).** `packages/ai-decision/tests/output/hub-e2e-transcript.json` is tracked, and `hub.test.ts:41` rewrites it in `afterAll` from the whole suite's accumulated results. The diff is 290 insertions / 0 deletions — only the new `direct: …` cases, in run order, with no churn of the pre-existing entries. It is byte-reproducible: running the suite twice, and again after my mutation run, regenerates exactly the same bytes (sha256 `0a5961aa…`). Because the suite rewrites it unconditionally, *any* gate run leaves it dirty if it is not updated, so including it is the correct resolution — not exclusion, not separate regeneration. The only wart is pre-existing: a suite run with failures leaves a partially written artifact; that is how the generator already behaves and is not introduced here, hence P4/DEFER.

**Residual risk.** (a) Deliberate, R1-sanctioned narrowing: the hub now rejects an answers map whose keys do not match the rendered request exactly, so a hypothetical maker that returns surplus keys for questions the hub did not ask falls back instead of having its asked answer used — the hub only ever builds one question, so no conforming maker is affected. (b) Resolved makers wrapped by `createDecisionMaker` are now validated twice (idempotent, no measurable cost; the full 2991-test suite and `decision-clef`'s own `validateAnswers` path stay green). (c) `### Testing` is still empty — expected at the review stage; the verify stage owns it with the receipt as evidence. (d) The transcript artifact stays a generated, committed file; any future suite change must regenerate it in the same commit.

### References

- Parent: docs/features/N1_decision-hub-answer-validation.md; docs/features/N_declarative-ai-decision-catalog-and-hub-in-ts-ai-decision.md; cancelled task 0106 is historical context only.
- packages/ai-decision/src/hub.ts and registry.ts; packages/ai-runner/src/decision/validation.ts, decision-maker.ts and index.ts; packages/ai-decision/tests/hub.test.ts.
- Confirmed again using /tmp/ts-libs-review-hub-repro.ts at refinement; 43 focused builder/hub tests pass before implementation. Scratch reproduction is supplemental to durable source evidence.
- No scheduling dependencies, active wip tasks or additional worktrees at refinement; package dependency already exists.

### History

- 2026-10-12T07:18:19.692Z backlog → todo (system)
- 2026-10-12T18:43:54.996Z todo → wip (system)
- 2026-10-12T18:55:53.320Z wip → testing (system)
- 2026-10-12T18:56:06.199Z testing → done (system)

