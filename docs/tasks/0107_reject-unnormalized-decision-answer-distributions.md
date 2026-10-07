---
schema_version: 1
name: Reject unnormalized decision answer distributions
status: done
template: feature-impl
created_at: 2026-10-07T18:46:46.478Z
updated_at: "2026-10-07T20:45:31.829Z"
feature_id: A

priority: P2
ac_numbering: task-local
ac_altitude: task-local
estimate_hours: 2
done_forced: "false"
done_reason: unforced close; PASS artifact at .spur/memory/evidence/0107-verdict.json
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

- [x] R1. Reject choice and score answers when the sum of already-valid probabilities has absolute distance from one greater than 1e-6, using the existing DecisionBackendError path at validateAnswers. Cover facade ask/choice/score and direct TypeSafe-driver calls.
- [x] R2. Accept mass error at most 1e-6 without changing answer data or object identity; preserve finite/range/key/legend validation, fractional expected scores within rubric bounds, special own-property keys, and noul's single [0,1] probability contract.
- [x] R3. Through an actual facade-wrapped driver registered with DecisionHub, malformed choice/score mass produces the declared fallback with source: default, reason: error, and confidence: null; normalized responses and existing backend suites remain compatible.

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

- [x] 0. Align dependencies with bun install --frozen-lockfile; confirm Bun 1.3.14 / zod 4.4.3 and no same-file concurrent work, preserving existing staged changes.
- [x] 1. Add fake-driver choice/score mass regressions through ask and sugar methods, plus batched-answer and direct TypeSafe-fetch cases; demonstrate rejection assertions fail before the fix (R1).
- [x] 2. Add the private 1e-6 constant and one post-validation numeric mass guard in validateAnswers, using existing fail(name) (R1, R2).
- [x] 3. Test accepted under/over tolerance, original object identity, fractional score, __proto__ keys, noul and existing malformed answers; add real-hub invalid-mass fallbacks for choice/score (R2, R3).
- [x] 4. Verify existing ai-runner decision, decision-fm, laya-mlx, and hub tests. Run bun run spur-check and bun run build, then inspect the final surgical diff; partial-suite coverage exits do not certify the full gate (R3).

### Solution

The shared response validator retains all existing shape, own-key, finite-entry, label, legend and noul checks. Choice/score probability entries are summed after those checks and rejected through the existing named DecisionBackendError when the raw absolute error exceeds the private 1e-6 tolerance. Both the facade and direct TypeSafe driver still call this boundary; no public API or production backend/hub mapping changed.

Verification repaired the missing evidence: both kinds now exercise masses 0, 0.5, 2, both outside-tolerance sides, ask and sugar methods, rejection of a mixed valid/invalid answer map, accepted under/over rounding with frozen original identity and fractional scores, and direct plus facade-wrapped TypeSafe wire mapping. Hub integration now verifies invalid score mass as well as choice mass, each selecting the declared fallback after one request.

Design adjustment: the committed test-only Laya stub normalizes its four-decimal canned distributions so valid backend compatibility tests remain valid under the new boundary (packages/laya-mlx/tests/fixtures/stub_laya.py:34,121,132). This changes fixture data only, not production mapping or validator normalization. Installed zod is aligned to the existing lock at 4.4.3; no dependency or manifest edits are needed.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | packages/ai-runner/src/decision/validation.ts:102-108 sums only validated entries and rejects raw absolute mass error above 1e-6 using the existing question-name error at line 75. Both callers remain at packages/ai-runner/src/decision/decision-maker.ts:187 and packages/ai-runner/src/decision/typesafe-driver.ts:91. packages/ai-runner/tests/decision/validation.test.ts:124-155 covers both kinds, masses 0/0.5/2 and both outside-tolerance sides, ask/sugar and whole mixed-response rejection; direct/wrapped wire checks at line 211. Fresh full gate: 2837 pass, 0 fail. |
| R2 | MET | packages/ai-runner/src/decision/validation.ts:79-100 preserves noul, finite/range, own keys, labels and legend checks before mass validation. packages/ai-runner/tests/decision/validation.test.ts:161-207 proves both kinds accept normalized and under/over-tolerance mass, fractional 0.8, frozen original map/answer/probability identity and noul 0/0.5/1; malformed cases at lines 51 and 80 and own-property wire keys at line 286 remain covered; fresh full gate: 2837 pass, 0 fail. |
| R3 | MET | packages/ai-decision/tests/hub.test.ts:70 registers real facade makers; lines 696-736 assert invalid choice and score use declared fallback, source default, reason error, null confidence and exactly one request. Normalized fractional score remains accepted at line 459. packages/ai-decision/src/hub.ts:328 retains existing error fallback; fresh full gate: 2837 pass, 0 fail. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| Scenario: AC1 — Invalid mass fails both choice and score validation (req: R1) | MET | test | packages/ai-runner/tests/decision/validation.test.ts:124-155 rejects masses 0/0.5/2 and 1 +/- 2e-6 for both kinds through ask and sugar; mixed response with a valid first question rejects as a whole with a named backend error. |
| Scenario: AC2 — Valid rounding and fractional scores remain accepted (req: R2) | MET | test | packages/ai-runner/tests/decision/validation.test.ts:161-207 accepts both rounding sides, upper boundary and closest lower representable inside value, rejects decimal 0.999999 outside raw bound, preserves frozen identity and fractional 0.8, accepts noul 0/0.5/1. Existing validation at lines 51-120 and __proto__ at line 286 remain intact. |
| Scenario: AC3 — Invalid mass selects the catalog fallback (req: R3) | MET | test | packages/ai-decision/tests/hub.test.ts:696-736 uses actual facade/registry integration for both kinds and asserts fallback, source, reason, confidence and one request; fractional accepted score at line 459. |
| Scenario: AC4 — Direct TypeSafe responses share mass validation (req: R1; R2) | MET | test | packages/ai-runner/tests/decision/validation.test.ts:211-247 injects successful JSON wire responses for both kinds, tests invalid mass and normalized/rounded valid responses through direct driver and facade-wrapped driver; mapping suite packages/ai-runner/tests/decision/typesafe-driver.test.ts:189 verifies all three answer kinds. |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

#### Review Report — 0107

**Scope:** working tree (no exact (0107)-tagged implementation commits), restricted to the task's two changed test files, with the committed validator, both immediate callers, real registry/hub integration and compatibility fixture reread as context.
**Dimensions:** functional, security, efficiency, correctness, usability, architecture.
**Verdict:** PASS

##### Findings (ranked)

| # | Priority | Dimension | Finding | Location | Disposition |
| --- | --- | --- | --- | --- | --- |
| 1 | P3 | correctness | Historical Testing claim that mass 1.0000001 is rejected contradicted the inclusive raw tolerance. Fresh evidence records accepted values inside the bound; no such rejection assertion remains. | packages/ai-runner/tests/decision/validation.test.ts:166 | RESOLVED |
| 2 | P3 | correctness | Historical lower-bound probe gap. Adjacent computed totals 0.9999990000000001 and 0.999999 now test inside acceptance and outside rejection for both kinds, alongside under/over rounding. | packages/ai-runner/tests/decision/validation.test.ts:166 | RESOLVED |
| 3 | P4 | all | No open P1-P3 findings across the shared boundary and task tests; both callers use the same nonmutating linear guard, private tolerance and named error, with real facade/driver/hub evidence. | packages/ai-runner/src/decision/validation.ts:73-108 | ACCEPTED |

##### Functional Traceability

| Req | Status | Evidence |
| --- | --- | --- |
| R1 | MET | packages/ai-runner/tests/decision/validation.test.ts:124-155 rejects all specified masses through ask/sugar and whole mixed responses; direct and wrapped wire paths at line 211. |
| R2 | MET | packages/ai-runner/tests/decision/validation.test.ts:161-207 covers rounding, frozen answer identity, fractional 0.8 and noul extremes; existing malformed and own-key cases remain. |
| R3 | MET | packages/ai-decision/tests/hub.test.ts:70,696-736 uses real registry/facade makers, both fallbacks and one-request assertions; normalized fractional success at line 459. |

##### SECUA Quality

The shared guard only sums entries after finite/range/key checks; response errors identify the question without raw probability diagnostics. Valid answers remain unchanged. It adds one linear traversal without a public flag, alternate boundary or dependency. All mass cases keep individual entries within range so failures exercise the mass invariant itself.

##### Architectural Depth

No candidates: validation remains in the neutral ai-runner boundary, shared by facade and direct TypeSafe entry points, consistent with ADR-026. Hub error fallback remains in the existing ADR-033 seam. Injected drivers/fetch provide a testable surface without new interfaces or helpers. The committed Laya normalization is test-only compatibility data.

**Validation:** bun run spur-check exit 0: 2837 pass / 0 fail, all package typechecks, Biome, 58 pre/2 post rules passed; bun run build exit 0 for every package. Receipts: .spur/run/0107-spur-check.log and .spur/run/0107-build.log.

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
- 2026-10-07T19:41:56.863Z todo → wip (system)
- 2026-10-07T19:59:11.480Z wip → testing (system)
- 2026-10-07T20:05:34.908Z testing → done (system)

