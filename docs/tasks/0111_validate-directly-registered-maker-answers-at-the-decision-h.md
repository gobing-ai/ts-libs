---
schema_version: 1
name: Validate directly registered maker answers at the decision hub boundary
status: todo
template: feature-impl
created_at: 2026-10-12T07:17:18.105Z
updated_at: "2026-10-12T16:15:31.991Z"
feature_id: N1

priority: P2
ac_numbering: task-local
ac_altitude: task-local
estimate_hours: 3
---

## 0111. Validate directly registered maker answers at the decision hub boundary

### Background

The 2026-10-12 inline review confirmed that directly registered custom DecisionMakers bypass the answer validator used by createDecisionMaker. packages/ai-decision/src/registry.ts:56 accepts a DecisionMaker or factory, but packages/ai-decision/src/hub.ts:291 checks only answer presence/kind before applying the confidence threshold. A choice answer with label 'undeclared', confidence NaN and probabilities {} is accepted with source:model; NaN is not less than the threshold. The reproduction in /tmp/ts-libs-review-hub-repro.ts constructs the actual registry and hub and loads a YAML catalog with yes/no criteria and fallback no. Built-in and createDecisionMaker-wrapped makers already validate through packages/ai-runner/src/decision/decision-maker.ts:193. Feature N promises fallback on invalid answers for consumer-registered makers. Direct triage fixes already address unrelated strict-glob and event-log directory defects. Task 0106 is cancelled and excluded arbitrary custom maker contracts; it does not own this repair. Preserve the valid fractional expected-score behavior it explicitly records.

**Refine corrections (2026-10-12)**
- Wrapped-maker validation was generalized to built-ins → createDecisionMaker validates but direct registry objects need not → freeze hub validation for every resolved maker without changing registry registration.
- Malformed-response coverage left distributions implicit → shared validateAnswers checks exact probability keys, finite bounded values, normalized mass and score legend → explicitly test these shared semantics at the direct-maker boundary.
- Custom-maker double shape was unspecified → existing ask is generic and convenience methods are part of DecisionMaker → implement a typed test helper, keeping malformed payload casts confined to test input.

### Requirements

- [ ] R1. Validate answers from every resolved maker against the rendered request questions inside DecisionHub.decide before confidence evaluation, reusing the public validateAnswers validator from ts-ai-runner.
- [ ] R2. Map malformed answers to the existing declared fallback with source:default, reason:error and confidence:null; preserve existing maker selection, caller-error throwing and backend-error mapping.
- [ ] R3. Add hub tests using directly registered custom makers for invalid labels, non-finite/out-of-range confidence, missing/extra answers and invalid score/noul values, while retaining valid custom answers and fractional expected scores; run both repository gates.

### Acceptance Criteria

- [ ] AC1 — Every maker's answer crosses validation (req: R1)
  Given a directly registered custom maker returning an undeclared choice label or NaN/infinite/out-of-range confidence, when decide is called on a valid catalog decision, then the answer is rejected before confidence gating and the declared fallback is returned.
- [ ] AC2 — Fallback and caller errors remain distinct (req: R2)
  Given malformed backend answers, when decide resolves, then source is default, reason is error, confidence is null and maker identifies the selected maker; unknown decisions, invalid inputs and unregistered per-call makers still throw before any maker ask.
- [ ] AC3 — Correspondence and valid values remain compatible (req: R3)
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

- [ ] 1. Add a direct custom maker hub regression for undeclared labels and NaN confidence; demonstrate it fails before the change (R1, R3).
- [ ] 2. Invoke the shared public answer validator inside the hub's existing fallback try/catch (R1, R2).
- [ ] 3. Cover malformed correspondence and all three answer kinds, probability keys/mass and score legends, valid fractional scores, and existing caller-error behavior (R2, R3).
- [ ] 4. Run bun test packages/ai-decision/tests/hub.test.ts, bun run spur-check and bun run build; inspect intentional status (R3).

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- Parent: docs/features/N1_decision-hub-answer-validation.md; docs/features/N_declarative-ai-decision-catalog-and-hub-in-ts-ai-decision.md; cancelled task 0106 is historical context only.
- packages/ai-decision/src/hub.ts and registry.ts; packages/ai-runner/src/decision/validation.ts, decision-maker.ts and index.ts; packages/ai-decision/tests/hub.test.ts.
- Confirmed again using /tmp/ts-libs-review-hub-repro.ts at refinement; 43 focused builder/hub tests pass before implementation. Scratch reproduction is supplemental to durable source evidence.
- No scheduling dependencies, active wip tasks or additional worktrees at refinement; package dependency already exists.

### History

- 2026-10-12T07:18:19.692Z backlog → todo (system)

