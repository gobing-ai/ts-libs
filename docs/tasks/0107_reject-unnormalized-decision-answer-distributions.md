---
schema_version: 1
name: Reject unnormalized decision answer distributions
status: todo
template: feature-impl
created_at: 2026-10-07T18:46:46.478Z
updated_at: "2026-10-07T19:20:11.018Z"
feature_id: A

priority: P2
ac_numbering: task-local
ac_altitude: task-local
estimate_hours: 2
---

## 0107. Reject unnormalized decision answer distributions

### Background

The 2026-10-07 review found missing probability-mass validation in packages/ai-runner/src/decision/validation.ts. Current validateAnswers checks answer names/kinds, confidence, exact probability keys, and each finite [0,1] entry; it never checks their sum. A fresh inline Bun probe through createDecisionMaker.ask accepted both choice and score distributions with masses 0, 0.5, and 2 (six malformed responses). The gap remains live.

Fractional scores are intentionally accepted by the facade validation test and the hub's facade-wrapped ScriptedDriver score test. Task 0106 is cancelled because its integer-score restriction was incorrect. Task 0086 is done; it is historical hardening context, not an implementation prerequisite. Current backlog/todo task-name inventory found no other decision/distribution task owning this gap.

**Refine corrections (2026-10-07)**

- “Validate once at the shared facade” → validateAnswers is called by both the facade and direct TypeSafe driver, with TypeSafe facade requests passing both → change the existing shared validator without removing either boundary or adding driver-specific checks.
- “Reject mass” without error-order detail → current failures use the question-name DecisionBackendError → preserve existing validation and fail(name), then add the mass check; no raw backend probabilities in diagnostics.
- Tolerance acceptance described only as rounding → absolute error at most 1e-6 is the contract for both under- and over-mass → freeze an inclusive computed-number boundary and tests comfortably inside/outside both sides.
- Checkbox-only AC bindings → the task-local requirement checker consumes Scenario lines → preserve AC1–AC3 titles as bound Gherkin scenarios and add direct TypeSafe/batched-answer coverage.
- Environment/concurrency assumed ready → Bun 1.3.14 but installed zod 4.2.1 versus locked 4.4.3; one main worktree/no wip tasks → add frozen-lockfile alignment as implementation step 0 and preserve existing staged review/source changes.

No DAG task or unrelated infra/utils review fix changes this validation seam. This refinement freezes the spec only.

### Requirements

- [ ] R1. Reject choice and score answers when the sum of already-valid probabilities has absolute distance from one greater than 1e-6, using the existing DecisionBackendError path at validateAnswers. Cover facade ask/choice/score and direct TypeSafe-driver calls.
- [ ] R2. Accept mass error at most 1e-6 without changing answer data or object identity; preserve finite/range/key/legend validation, fractional expected scores within rubric bounds, special own-property keys, and noul's single [0,1] probability contract.
- [ ] R3. Through an actual facade-wrapped driver registered with DecisionHub, malformed choice/score mass produces the declared fallback with source: default, reason: error, and confidence: null; normalized responses and existing backend suites remain compatible.

Out of scope: integer-score restrictions, rounding/renormalization, score-expectation or argmax consistency, confidence calibration, validation of arbitrary custom makers bypassing the facade, new dependencies/public types/flags, backend-specific mapping changes, and unrelated package fixes.

### Acceptance Criteria

```gherkin
Feature: Validated decision distribution mass

  Scenario: AC1 — Invalid mass fails both choice and score validation (req: R1)
    Given fake drivers returning otherwise valid choice or score answers
    When ask, choice, or score receives mass 0, 0.5, 2, or an error above tolerance on either side of one
    Then it rejects with DecisionBackendError through the existing question-name failure path
    And a multi-question ask containing one invalid distribution rejects the whole response

  Scenario: AC2 — Valid rounding and fractional scores remain accepted (req: R2)
    Given normalized or slightly under- or over-normalized mass within tolerance
    And a fractional score in rubric range or a choice with an own __proto__ label
    When the facade validates the answer
    Then it accepts the original answer unchanged
    And noul probabilities including 0, 0.5, and 1 retain their existing behavior
    And malformed keys, confidence, probability entries, score bounds, and legends still fail

  Scenario: AC3 — Invalid mass selects the catalog fallback (req: R3)
    Given a real DecisionHub registry using createDecisionMaker around a scripted choice or score driver
    When decide receives malformed mass
    Then it resolves the declared fallback with source default, reason error, and null confidence
    And a normalized fractional-score response remains accepted
    And existing backend tests and repository verification pass

  Scenario: AC4 — Direct TypeSafe responses share mass validation (req: R1; R2)
    Given createTypesafeDriver with an injected fetch returning validly shaped wire answers
    When choice or score wire probabilities have invalid mass
    Then the direct driver rejects with DecisionBackendError
    And normalized wire answers and facade-wrapped TypeSafe answers retain their existing mapping
```

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-10-07T19:20:09.635Z

- Decision: absolute tolerance is fixed at 1e-6, inclusive on the computed number; no renormalization or second epsilon.
- Decision: retain the validator at both existing callers, including direct TypeSafe use; do not change driver mapping or hub production logic.
- Decision: malformed mass uses existing fail(name)/DecisionBackendError; preserve valid answer identity and fractional scores.
- Decision: no prerequisite work or public API change. Cancelled 0106's integer-score restriction remains excluded.
- Decision: installed dependency mismatch is resolved at implementation step 0; this turn changes task planning sections only.

### Design

No new public API. WHAT/WHY: enforce probability mass at the existing provider-neutral response boundary instead of accepting impossible distributions. WHERE: packages/ai-runner/src/decision/validation.ts; tests/decision/validation.test.ts; packages/ai-decision/tests/hub.test.ts. Existing fetch injection in validation.test.ts is sufficient for direct TypeSafe coverage. No production hub, registry, facade, or backend-driver edits.

Frozen algorithm: retain the noul early continue and all existing checks. After probability keys/entries and choice label or score/legend validation pass, sum Object.values(answer.probabilities) with a numeric accumulator. Compare Math.abs(total - 1) > 1e-6; on failure call the existing fail(name). Use a private module constant DISTRIBUTION_MASS_TOLERANCE = 1e-6. The comparison is inclusive on the computed JavaScript number; do not add another epsilon, make tolerance configurable, coerce malformed values, round scores, rewrite probabilities, or introduce a utility abstraction. Existing entry checks establish finite numbers in [0,1] before summing. Preserve the existing DecisionBackendError message and avoid embedding response bodies.

Caller map: createDecisionMaker.ask calls validateAnswers and returns the original answer map; choice/score/noul sugar delegates to ask. createTypesafeDriver.ask also calls validateAnswers directly after mapping the SDK answer. Retain both calls: direct driver users require their own boundary. fm-local and laya-local flow through the facade when used as makers; standalone raw driver mapping is unchanged.

Observability: use actual createDecisionMaker with injected DecisionDriver for mass and identity tests, never mock validateAnswers. For each choice/score kind test masses 0, 0.5, 2 and totals 1 ± 2e-6 (reject), 1 ± 0.5e-6 (accept), and 1 (accept). Distribute mass across two entries so each stays in [0,1]; test represented-number behavior rather than assuming a decimal exactly equals a binary boundary. Use both ask and the corresponding sugar method, and one multi-question invalid-answer case. Valid answer/map identity and unchanged entries prove no normalization. Keep fractional 0.8 scores, normalized one-hot choices, __proto__ own keys, and existing malformed/noul cases.

For direct TypeSafe tests reuse createTypesafeDriver({apiKey: 'test', maxRetries: 0, fetch: injectedFetch}) with Response.json wire payloads; no network/key access. For hub tests extend existing makeHub/ScriptedDriver helpers, which register createDecisionMaker({driver}) in a real DecisionMakerRegistry. Return otherwise-valid choice/score responses with high confidence and invalid mass so the fallback reason observes boundary rejection, not the low-confidence branch. Assert source/default, declared value, reason/error, null confidence, and one driver request. Do not stub maker.ask to throw manually or change hub.ts to duplicate validation.

Dependencies/decisions: no unfinished prerequisite, no new dependency edge needed, no declared downstream task. 0086 is historical completed context; 0106 is cancelled and must not be resurrected. ADR-026 assigns neutral validation to ai-runner; ADR-033 assigns ask-error fallback to the hub. This correction fits both without an ADR amendment. No generated artifact edits during refinement.

Environment: before implementation run bun install --frozen-lockfile to align installed zod 4.2.1 to locked 4.4.3, retaining manifests and bun.lock. One main worktree and no wip task conflicts were found; preserve staged/uncommitted work from prior reviews.

### Plan

- [ ] 0. Align dependencies with bun install --frozen-lockfile; confirm Bun 1.3.14 / zod 4.4.3 and no same-file concurrent work, preserving existing staged changes.
- [ ] 1. Add fake-driver choice/score mass regressions through ask and sugar methods, plus batched-answer and direct TypeSafe-fetch cases; demonstrate rejection assertions fail before the fix (R1).
- [ ] 2. Add the private 1e-6 constant and one post-validation numeric mass guard in validateAnswers, using existing fail(name) (R1, R2).
- [ ] 3. Test accepted under/over tolerance, original object identity, fractional score, __proto__ keys, noul and existing malformed answers; add real-hub invalid-mass fallbacks for choice/score (R2, R3).
- [ ] 4. Verify existing ai-runner decision, decision-fm, laya-mlx, and hub tests. Run bun run spur-check and bun run build, then inspect the final surgical diff; partial-suite coverage exits do not certify the full gate (R3).

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- docs/00_ADR.md:456 — ADR-026 neutral validation ownership; :623 — ADR-033 error fallback.
- Feature A; 0086 done (historical hardening); 0106 cancelled (incorrect integer-score draft).
- packages/ai-runner/src/decision/validation.ts:70 — shared answer validator; :79 — noul early path; :84 — probability entry validation.
- packages/ai-runner/src/decision/decision-maker.ts:187 — facade validation; sugar methods delegate to ask.
- packages/ai-runner/src/decision/typesafe-driver.ts:91 — direct mapped-answer validation.
- packages/ai-runner/tests/decision/validation.test.ts:76 — fractional-score contract and existing injected-fetch tests.
- packages/ai-decision/tests/hub.test.ts:70 — facade-backed registry helper; :459 — fractional hub score; :674 — existing malformed-answer fallback tests.
- packages/ai-decision/src/hub.ts:328 — existing ask-error taxonomy.
- Fresh probe 2026-10-07: facade accepted masses 0, 0.5, and 2 for each of choice/score.
- Audit 2026-10-07: Bun 1.3.14, installed zod 4.2.1 versus lock 4.4.3; one main worktree, no wip tasks. CLI backlog/todo inventory found only 0107 matching decision/distribution ownership.

### History

- 2026-10-07T18:47:01.885Z backlog → todo (system)

