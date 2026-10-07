---
schema_version: 1
name: Reject fractional scores and unnormalized decision distributions
status: cancelled
template: feature-impl
created_at: 2026-10-07T18:45:43.214Z
updated_at: "2026-10-07T18:46:31.059Z"
feature_id: A

priority: P2
ac_numbering: task-local
ac_altitude: task-local
---

## 0106. Reject fractional scores and unnormalized decision distributions

### Background

Withdrawn during the same review: packages/ai-runner/tests/decision/validation.test.ts:76 and packages/ai-decision/tests/hub.test.ts:459 explicitly permit fractional expected scores. The proposed integer-score restriction was based on an incorrect premise and must not be implemented. Probability-mass validation will be filed separately with the existing fractional-score behavior preserved.

### Requirements

- [ ] R1. Reject score answers whose score is not an integer rubric index, through DecisionBackendError in the shared answer validator used by ask and sugar methods.
- [ ] R2. Reject choice/score distributions whose probabilities do not sum to one within a declared floating-point tolerance, while retaining existing finite/range/key validation.
- [ ] R3. Preserve valid driver answers and ensure a hub using the DecisionMaker facade falls back on invalid responses. Out of scope: calibration, argmax constraints, arbitrary custom maker contracts, backend dependencies, or changes to public types.

### Acceptance Criteria

- [ ] AC1 — Fractional scores fail the neutral response boundary (req: R1)
  Given an injected driver returning score:0.5 for a two-level rubric with otherwise valid fields, when ask or score is called, then DecisionBackendError is raised; integer boundary values remain accepted.
- [ ] AC2 — Invalid distribution mass fails for choice and score (req: R2)
  Given zero mass or excess mass probabilities, when either answer type is validated, then DecisionBackendError is raised; valid rounded distributions within tolerance pass.
- [ ] AC3 — Hub fallback and valid backends remain compatible (req: R3)
  Given a catalog hub with a facade-wrapped bad driver, when its answer fails validation, then decide resolves the declared fallback with reason:error; valid fake-driver and existing backend tests and both repository gates pass.

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

No new API. In validation.ts, require Number.isInteger(answer.score) after the existing numeric bounds and sum the already-validated probabilities, accepting absolute error at most 1e-6. Keep noul validation unchanged because it is a single probability. Validate in the shared facade rather than independently patching drivers or rounding a malformed score into a fabricated answer. Do not enforce argmax or confidence calibration: those are separate policies. Targets: packages/ai-runner/src/decision/validation.ts, tests/decision/decision-maker.test.ts and packages/ai-decision/tests/hub.test.ts. Add a narrow tolerance test at the shared seam; no dependency additions or ADR changes.

### Plan

- [ ] 1. Add separate fractional-score and invalid-mass regressions through a fake driver (R1, R2).
- [ ] 2. Add integer and normalized-mass guards at validateAnswers (R1, R2).
- [ ] 3. Verify valid rounded distributions and catalog fallback for malformed responses (R3).
- [ ] 4. Run existing decision/backend tests, bun run spur-check and bun run build (R3).

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- ADR-026 and ADR-033 in docs/00_ADR.md.
- Feature A; task 0086 (prior hardening, complete).
- packages/ai-runner/src/decision/validation.ts:84
- packages/ai-runner/src/decision/validation.ts:93
- packages/ai-decision/src/hub.ts:319

### History

- 2026-10-07T18:46:31.059Z backlog → cancelled (system)

