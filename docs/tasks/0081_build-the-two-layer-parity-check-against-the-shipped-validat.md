---
schema_version: 1
name: Build the two-layer parity check against the shipped validation fixture
status: todo
template: feature-impl
created_at: 2026-09-21T03:11:42.101Z
updated_at: "2026-09-21T03:11:56.368Z"
feature_id: J
priority: P1
tags:
  - laya-mlx
  - testing
  - parity
estimate_hours: 5

dependencies: ["0077", "0078", "0079"]
---

## 0081. Build the two-layer parity check against the shipped validation fixture

### Background

The checkpoint ships a 63-question validation.json with recorded expectations, which makes correctness a test rather than an opinion. But the default test run must not require an interpreter or a 643 MB download, and the project gate forbids skipping a test to go green. Two layers resolve that tension.

### Requirements

- [ ] R1. A protocol fixture layer runs in the default test run against a stub process, with committed request and response lines.
- [ ] R2. The protocol layer covers request construction, line framing, correlation, answer mapping, and every error branch.
- [ ] R3. A full parity layer answers all 63 fixture questions through the driver on a provisioned host and reports the agreement count.
- [ ] R4. Each returned choice label, score, and yes-probability matches the fixture's recorded expectation within the documented tolerance.
- [ ] R5. The full parity layer is selected by its own script rather than skipped at runtime, so the default run contains no skipped test.
- [ ] R6. The documented tolerance is recorded with the reason it is not exact equality.

### Acceptance Criteria

- [ ] AC1 — Local answers agree with the reference implementation on the shipped validation fixture (req: R3, R4, R6)

The default `bun run test` run includes the protocol layer and contains no skipped test (R1, R2, R5).

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

**What.** Two test layers with different provisioning requirements, and the script boundary that separates them.

**Why two layers.** The default gate has to run on any machine, including hosted CI with no Apple Silicon and no checkpoint. Full parity needs both. Collapsing them would mean either a gate that cannot run or a test that skips itself — and a skipped test that goes green is exactly what the project gate forbids.

**Why the split falls where it does.** The layers divide along what this package actually owns. Calibration and answer construction are the installed runtime's, verified upstream and inherited. What can drift here is the bridge: request construction, framing, correlation, mapping, and error translation. That is all deterministic given recorded worker lines, so it runs everywhere, always — which is the right place for the fast layer, because it is also the layer that changes.

**Why a separate script rather than a runtime skip.** A conditional skip reports success on a machine that ran nothing, and the distinction between passed and not-attempted disappears from the output. A separate script makes the provisioned lane something a maintainer runs deliberately and a result they read deliberately.

**Why a tolerance at all.** The worker returns probabilities already rounded to four decimal places, and dtype affects the low-order digits. Exact equality across precisions would make the fixture a dtype regression test rather than a correctness one. Documenting the tolerance and its reason keeps the check honest about what it proves.

### Plan

1. Record worker request and response lines for a representative question of each type, plus each error kind.
2. Commit them under tests/fixtures with a note on how to regenerate them.
3. Build the stub process the protocol layer drives, replaying recorded lines.
4. Cover construction, framing, correlation, mapping, and every error branch against it.
5. Write the full parity runner reading the checkpoint's validation.json.
6. Report the agreement count and the first disagreement, if any, in the runner's output.
7. Wire the parity runner to its own script and document the provisioning it needs.
8. Record the tolerance and its reason in the package README.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History
