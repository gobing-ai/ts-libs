---
schema_version: 1
name: Map worker answers onto the neutral decision types
status: done
template: feature-impl
created_at: 2026-09-21T03:11:42.098Z
updated_at: "2026-09-21T06:47:12.820Z"
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
| R1 | MET | `packages/laya-mlx/src/driver.ts:133-163` (`createLayaDriver` returns object with `name: 'laya-local'`, single `ask` method, and no `choice`/`score`/`noul` sugar); proven by `packages/laya-mlx/tests/driver.test.ts:18-45`. |
| R2 | MET | `packages/laya-mlx/src/driver.ts:76-88` (`mapWorkerAnswer` maps choice answers to `{ kind: 'choice', label, confidence, probabilities }`); proven by `packages/laya-mlx/tests/driver.test.ts:47-65`. |
| R3 | MET | `packages/laya-mlx/src/driver.ts:89-118` (`mapWorkerAnswer` maps score answers to `{ kind: 'score', score, confidence, legend, probabilities }`); proven by `packages/laya-mlx/tests/driver.test.ts:67-87`. |
| R4 | MET | `packages/laya-mlx/src/driver.ts:119-130` (`mapWorkerAnswer` maps noul answers to `{ kind: 'noul', probability }` with no confidence field present); proven by `packages/laya-mlx/tests/driver.test.ts:89-107`. |
| R5 | MET | `packages/laya-mlx/src/driver.ts:76-130` (`action.act_probability` is explicitly stripped and never exposed on neutral answers); proven by `packages/laya-mlx/tests/driver.test.ts:62-64,84-86,104-106`. |
| R6 | MET | `packages/laya-mlx/src/driver.ts:149-160` (`ask` iterates caller's `questions` map and returns each answer keyed by question name); proven by `packages/laya-mlx/tests/driver.test.ts:109-132`. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC1 | MET | test | `bun test` gate run (recorded in `.spur/run/0078-test-gate.log`, proof-digest `sha256:5c234b59…`): `packages/laya-mlx/tests/driver.test.ts:18-45` proves `createLayaDriver` satisfies the `DecisionDriver` contract, cleanly integrates with `createDecisionMaker` from `@gobing-ai/ts-ai-runner`, and answers choice, score, and noul questions without sugar. |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

<!-- spur:record-review -->

**SECU findings** (pipeline verify step — verdict: PASS)

| Priority | Dimension | Location | Finding |
|----------|-----------|----------|----------|
| P4 | spur task check | — | task check passed |
| P4 | evidence-rule-pass | — | All behavior-bearing AC rows have executable evidence or are explicitly non-behavioral. |

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-09-21T06:45:23.650Z todo → wip (system)
- 2026-09-21T06:47:12.253Z wip → testing (system)
- 2026-09-21T06:47:12.820Z testing → done (system)

