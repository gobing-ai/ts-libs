---
schema_version: 1
name: Validate directly registered maker answers at the decision hub boundary
status: done
template: feature-impl
created_at: 2026-10-12T07:17:18.105Z
updated_at: "2026-10-12T21:23:41.876Z"
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

Every resolved maker crosses the existing shared validateAnswers boundary immediately after ask resolves and before confidence gating (`packages/ai-decision/src/hub.ts:296`). The call remains in the existing fallback try/catch with inAsk set, preserving error fallback metadata, maker selection, timeout/construction distinctions and pre-backend caller errors.

Direct-maker tests bypass createDecisionMaker and cover undeclared labels, non-finite/out-of-range confidence, answer correspondence, distributions, score legends/bounds and noul values. Valid custom answers, fractional expected scores and caller errors are pinned by `packages/ai-decision/tests/hub.test.ts:1003`, `packages/ai-decision/tests/hub.test.ts:1169` and `packages/ai-decision/tests/hub.test.ts:1211`.

**Scope extension requested before commit:** the transcript hook at `packages/ai-decision/tests/hub.test.ts:38` now compares each accumulated result with the checked-in transcript instead of overwriting it. New or changed cases fail their evidence assertion until the transcript is deliberately updated. Failed or filtered runs cannot truncate it. A filtered caller-error run preserves the transcript SHA-256; no test-output write remains in the hook. No public API or backend policy changes.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | Every resolved maker crosses validateAnswers after ask and before confidence evaluation at `packages/ai-decision/src/hub.ts:296`. Direct-maker label and non-finite confidence regressions `packages/ai-decision/tests/hub.test.ts:1003` and `packages/ai-decision/tests/hub.test.ts:1036` passed. |
| R2 | MET | Caller validation stays before the fallback try/catch in `packages/ai-decision/src/hub.ts:262`; shared validation executes with inAsk true at `packages/ai-decision/src/hub.ts:291`. Fallback metadata and no-ask caller-error tests at `packages/ai-decision/tests/hub.test.ts:1003` and `packages/ai-decision/tests/hub.test.ts:1211` passed; existing construction/timeout and maker-precedence tests also passed. |
| R3 | MET | Exact answer correspondence and wrong-kind tests at `packages/ai-decision/tests/hub.test.ts:1053`, `packages/ai-decision/tests/hub.test.ts:1084`; distribution, score and noul tests at `packages/ai-decision/tests/hub.test.ts:1097`, `packages/ai-decision/tests/hub.test.ts:1128`, `packages/ai-decision/tests/hub.test.ts:1150`; valid choice, fractional score and noul at `packages/ai-decision/tests/hub.test.ts:1169` all passed. Canonical gate and build exited zero. Transcript evidence at `packages/ai-decision/tests/hub.test.ts:38` is asserted against the checked-in file without writing it. A filtered test run preserved the transcript SHA-256 with zero assertion failures. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC1 — Every maker's answer crosses validation (req: R1) | MET | test | Every resolved maker crosses validateAnswers after ask and before confidence evaluation at `packages/ai-decision/src/hub.ts:296`. Direct-maker label and non-finite confidence regressions `packages/ai-decision/tests/hub.test.ts:1003` and `packages/ai-decision/tests/hub.test.ts:1036` passed. |
| AC2 — Fallback and caller errors remain distinct (req: R2) | MET | test | Caller validation stays before the fallback try/catch in `packages/ai-decision/src/hub.ts:262`; shared validation executes with inAsk true at `packages/ai-decision/src/hub.ts:291`. Fallback metadata and no-ask caller-error tests at `packages/ai-decision/tests/hub.test.ts:1003` and `packages/ai-decision/tests/hub.test.ts:1211` passed; existing construction/timeout and maker-precedence tests also passed. |
| AC3 — Correspondence and valid values remain compatible (req: R3) | MET | test | Exact answer correspondence and wrong-kind tests at `packages/ai-decision/tests/hub.test.ts:1053`, `packages/ai-decision/tests/hub.test.ts:1084`; distribution, score and noul tests at `packages/ai-decision/tests/hub.test.ts:1097`, `packages/ai-decision/tests/hub.test.ts:1128`, `packages/ai-decision/tests/hub.test.ts:1150`; valid choice, fractional score and noul at `packages/ai-decision/tests/hub.test.ts:1169` all passed. Canonical gate and build exited zero. Transcript evidence at `packages/ai-decision/tests/hub.test.ts:38` is asserted against the checked-in file without writing it. A filtered test run preserved the transcript SHA-256 with zero assertion failures. |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

| Priority | Location | Finding | Disposition |
| --- | --- | --- | --- |
| P4 | `packages/ai-decision/tests/hub.test.ts:38` | Automatic transcript rewriting could truncate tracked evidence after a failed/filtered run. | FIXED — assert recorded results against the checked-in transcript without writing it; filtered run leaves its SHA-256 unchanged. |

Reviewed security, efficiency, correctness, usability and architecture. Direct makers cross the shared validator before confidence gating; existing fallback and caller-error taxonomy, valid fractional scores and normalized-distribution policy remain intact. Tests use directly registered makers so wrapper validation cannot hide the bug. No open findings or deferrals remain.

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

