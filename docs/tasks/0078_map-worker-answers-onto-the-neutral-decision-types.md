---
schema_version: 1
name: Map worker answers onto the neutral decision types
status: done
template: feature-impl
created_at: 2026-09-21T03:11:42.098Z
updated_at: "2026-09-21T18:34:35.659Z"
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

- [x] R1. createLayaDriver returns a value satisfying DecisionDriver, with a readonly name and a single ask method, and exposes no choice/score/noul sugar.
- [x] R2. A choice answer carries the selected label, a confidence, and a probability per supplied label.
- [x] R3. A score answer carries the score, a confidence, the legend, and a probability per rubric index.
- [x] R4. A noul answer carries only the yes-probability, with no confidence field present or synthesized.
- [x] R5. The reference's action probability is not surfaced on any neutral answer.
- [x] R6. Every answer in a request is returned keyed by its question name, in the caller's question set.

### Acceptance Criteria

- [x] AC1 — The local driver satisfies the same DecisionDriver contract as the hosted backend (req: R1, R2, R3, R4, R5)

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

Each entry cites the first changed line per file (`file:line`).

| Change (`file:line`) |
| --------------------- |
| `packages/laya-mlx/src/driver.ts:1` |
| `packages/laya-mlx/src/index.ts:1` |
| `packages/laya-mlx/src/worker-client.ts:1` |
| `packages/laya-mlx/tests/driver.test.ts:1` |
| `packages/laya-mlx/tests/index.test.ts:1` |
| `packages/laya-mlx/tests/prerequisites-and-taxonomy.test.ts:1` |
| `packages/laya-mlx/tests/worker-client.test.ts:1` |
| `packages/laya-mlx/tests/worker-protocol.test.ts:1` |

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/laya-mlx/src/driver.ts:148-178` createLayaDriver returns `{ name: 'laya-local', ask }` satisfying DecisionDriver, no sugar methods; tests `driver.test.ts:15` (readonly name, single ask) and :29 (substitutable in createDecisionMaker); package typecheck exit 0 this run |
| R2 | MET | Choice mapping `driver.ts:74-87` (label, confidence, probabilities per label; malformed labels rejected); test `driver.test.ts:53`; live parity run: all choice labels agree on content-bearing cases |
| R3 | MET | Score mapping `driver.ts:88-125` — score is the categorical rubric index (argmax over per-level probabilities), with confidence, legend, and per-index probabilities; tests `driver.test.ts:74,95` (expectation 1.8451 → category 2); live parity: every score question agrees |
| R4 | MET | Noul branch `driver.ts:126-140` returns only `{ kind, probability }` — confidence deliberately dropped, missing/non-finite probability rejected; test `driver.test.ts:113,133`; protocol-fixture.test.ts:158 verifies stripping over the wire |
| R5 | MET | No branch in `mapWorkerAnswer` (:68-146) surfaces `action.act_probability`; driver.ts:66 documents the deliberate drop |
| R6 | MET | `driver.ts:172-180` answers keyed by the caller's question names; missing per-question answer raises DecisionBackendError; test `driver.test.ts:146` |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| R4 — The local driver satisfies the same DecisionDriver contract as the hosted backend | MET | test | Fresh `bun test` (49 pass / 0 fail) + `tsc --noEmit` exit 0: driver compiles as DecisionDriver with readonly name + single ask; answer shapes match the hosted contract (driver.test.ts:15,29,53,74,113); noul carries only yes-probability; live parity run (63/63 agreed, exit 0) confirms the shapes end to end through the real worker |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

<!-- spur:record-review -->

**SECU findings** (pipeline verify step — verdict: PASS)

| Priority | Dimension | Location | Finding |
|----------|-----------|----------|----------|
| P4 | spur task check | — | task check passed |
| P4 | tests-pass | — | `bun test` packages/laya-mlx: 49 pass / 0 fail (this run, incl. argmax pinning + malformed-answer rejection tests) |
| P4 | typecheck | — | `tsc --noEmit` exit 0 (this run) |
| P4 | design-conformance | — | Mapping layer matches Design: neutral shapes, deliberate confidence/action drops; score semantics corrected to the documented categorical contract during this fix pass |
| P4 | fix-pass | — | --fix all repaired: score criteria wire shape (driver.ts:41-49), score expectation→category mapping (driver.ts:88-125), silent defaulting on malformed worker answers (driver.ts:74-140); artifacts touched: .spur/run/0078-verify-answer.txt (this file), .spur/run/0078-verdict.json |
| P4 | evidence-rule-pass | — | All behavior-bearing AC rows have executable evidence or are explicitly non-behavioral. |

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-09-21T06:45:23.650Z todo → wip (system)
- 2026-09-21T06:47:12.253Z wip → testing (system)
- 2026-09-21T06:47:12.820Z testing → done (system)

