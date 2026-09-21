---
schema_version: 1
name: Map worker answers onto the neutral decision types
status: todo
template: feature-impl
created_at: 2026-09-21T03:11:42.098Z
updated_at: "2026-09-21T03:11:55.703Z"
feature_id: J
priority: P1
tags:
  - laya-mlx
  - mapping
  - contract
estimate_hours: 4

dependencies: ["0076"]
---

## 0078. Map worker answers onto the neutral decision types

### Background

The worker returns the reference implementation's answer JSON. The driver's remaining job is to satisfy DecisionDriver from ts-ai-runner and produce the same neutral answer shapes the hosted driver returns, so the two are substitutable. One asymmetry is deliberate: the reference computes a noul confidence that the neutral contract does not carry.

### Requirements

- [ ] R1. createLayaDriver returns a value satisfying DecisionDriver, with a readonly name and a single ask method, and exposes no choice/score/noul sugar.
- [ ] R2. A choice answer carries the selected label, a confidence, and a probability per supplied label.
- [ ] R3. A score answer carries the score, a confidence, the legend, and a probability per rubric index.
- [ ] R4. A noul answer carries only the yes-probability, with no confidence field present or synthesized.
- [ ] R5. The reference's action probability is not surfaced on any neutral answer.
- [ ] R6. Every answer in a request is returned keyed by its question name, in the caller's question set.

### Acceptance Criteria

- [ ] AC1 — The local driver satisfies the same DecisionDriver contract as the hosted backend (req: R1, R2, R3, R4, R5)

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

**What.** The translation from the worker's answer payload to the neutral answer union, plus the factory that assembles the driver.

**Why translate rather than pass through.** The worker's payload is the reference implementation's own shape, which carries two fields the neutral contract deliberately does not have: a noul confidence and an action probability. Passing the payload through would leak a wider surface than the hosted driver offers, and callers would start depending on fields that the TypeSafe backend cannot produce — silently breaking substitutability in the direction the tests would not catch.

**Why drop the noul confidence.** NoulAnswer carries a bare probability by contract, because for a binary question the probability already is the confidence — the reference's value is a restatement, `max(p, 1-p)`. Adding a field the hosted driver never sets would make the two backends distinguishable at the type level.

**Why no sugar on the driver.** DecisionDriver is a one-method seam and the DecisionMaker facade owns the typed helpers. A driver that also offered `choice()` and `score()` would create a second, subtly different path to the same answer and a second place to keep in sync.

**Why no arithmetic here.** Calibration, softmax, and confidence are computed by the installed runtime. Restating any of it in TypeScript would create a second implementation that can disagree with the model, which is precisely the failure mode the process bridge was chosen to avoid. The mapping layer moves fields; it does not compute them.

### Plan

1. Define the internal worker-payload types mirroring the runtime's answer JSON.
2. Write the per-question mapper with a branch per question type.
3. Drop the noul confidence and the action probability explicitly, with a comment naming the contract reason.
4. Preserve the incoming rounding rather than re-rounding.
5. Assemble createLayaDriver over the lifecycle layer and the mapper.
6. Type-check the result against DecisionDriver with no cast.
7. Cover each question type and the dropped fields against recorded payloads.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History
