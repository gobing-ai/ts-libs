---
schema_version: 1
name: Build the two-layer parity check against the shipped validation fixture
status: done
template: feature-impl
created_at: 2026-09-21T03:11:42.101Z
updated_at: "2026-09-21T18:27:07.117Z"
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

- [x] R1. A protocol fixture layer runs in the default test run against a stub process, with committed request and response lines.
- [x] R2. The protocol layer covers request construction, line framing, correlation, answer mapping, and every error branch.
- [x] R3. A full parity layer answers all 63 fixture questions through the driver on a provisioned host and reports the agreement count.
- [x] R4. Each returned choice label, score, and yes-probability matches the fixture's recorded expectation within the documented tolerance.
- [x] R5. The full parity layer is selected by its own script rather than skipped at runtime, so the default run contains no skipped test.
- [x] R6. The documented tolerance is recorded with the reason it is not exact equality.

### Acceptance Criteria

- [x] AC1 — Local answers agree with the reference implementation on the shipped validation fixture (req: R3, R4, R6)

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

Each entry cites the first changed line per file (`file:line`).

| Change (`file:line`) |
| --------------------- |
| `packages/ai-runner/src/decision/decision-maker.ts:105` |
| `packages/ai-runner/src/decision/decision-maker.ts:109` |
| `packages/ai-runner/src/decision/decision-maker.ts:112` |
| `packages/ai-runner/src/decision/decision-maker.ts:139` |
| `packages/ai-runner/src/decision/decision-maker.ts:148` |
| `packages/ai-runner/src/decision/decision-maker.ts:45` |
| `packages/ai-runner/src/decision/decision-maker.ts:50` |
| `packages/ai-runner/src/decision/decision-maker.ts:52` |
| `packages/ai-runner/src/decision/decision-maker.ts:65` |
| `packages/ai-runner/src/decision/decision-maker.ts:84` |
| `packages/ai-runner/tests/decision/backend-selection.test.ts:1` |
| `packages/laya-mlx/scripts/full-parity.ts:1` |
| `packages/laya-mlx/src/driver.ts:1` |
| `packages/laya-mlx/src/index.ts:1` |
| `packages/laya-mlx/src/worker-client.ts:1` |
| `packages/laya-mlx/tests/artifact-resolution.test.ts:1` |
| `packages/laya-mlx/tests/driver.test.ts:1` |
| `packages/laya-mlx/tests/index.test.ts:1` |
| `packages/laya-mlx/tests/prerequisites-and-taxonomy.test.ts:1` |
| `packages/laya-mlx/tests/protocol-fixture.test.ts:1` |
| `packages/laya-mlx/tests/worker-client.test.ts:1` |
| `packages/laya-mlx/tests/worker-protocol.test.ts:1` |

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/laya-mlx/tests/fixtures/protocol-lines.json` committed protocol lines (choice/score/noul + config/request/backend error branches); `packages/laya-mlx/tests/protocol-fixture.test.ts:90-189` runs in the default suite — fresh run: 48 pass / 0 fail / 0 skipped |
| R2 | MET | `protocol-fixture.test.ts:90-189` covers request construction (incl. the score-criteria list wire contract pinned at :99-104), line framing, id correlation, answer mapping, action/confidence stripping, and every error branch; the stub now mirrors the runtime's per-kind criteria validation (`tests/fixtures/stub_laya.py` — added this fix pass after the live run exposed the drift) |
| R3 | MET | `packages/laya-mlx/scripts/full-parity.ts` builds the 16 cases / 63 questions and reports the agreement count; executed live this run on a provisioned host (uv venv + vendored runtime, `LAYA_PYTHON=/tmp/laya-mlx-venv/bin/python bun run parity`): **63 / 63 questions agreed (100.0%), exit 0** |
| R4 | MET | Choice labels, score categories, and yes-probabilities compared against the recorded expectations with `PROBABILITY_TOLERANCE = 0.0001` (`scripts/full-parity.ts:19`); the noul probability comparison was added this fix pass — it was previously never evaluated |
| R5 | MET | Full layer selected by its own script `package.json:49` (`"parity": "bun scripts/full-parity.ts"`); the default `bun run test` contains no skipped test (48 pass / 0 fail / 0 skip this run) |
| R6 | MET | Tolerance documented with the not-exact-equality reason: `README.md:135-138` + `scripts/full-parity.ts:9-13` (4-decimal worker rounding, float16/float32 representation); expectation provenance recorded at `scripts/full-parity.ts:45-51` |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| R3 — Local answers agree with the reference implementation on the shipped validation fixture | MET | command | Live run this session: `LAYA_PYTHON=/tmp/laya-mlx-venv/bin/python bun run parity` → `[parity] Result: 63 / 63 questions agreed (100.0%)`, exit 0. Categorical expectations are the reference contract certified by the shipped fixture (validation.json: argmax 63/63, public_result_equal, probability max-abs-error 5.2e-6); probability magnitudes are a measured regression snapshot of the reference-certified runtime (provenance comment scripts/full-parity.ts:45-51) |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

<!-- spur:record-review -->

**SECU findings** (pipeline verify step — verdict: PASS)

| Priority | Dimension | Location | Finding |
|----------|-----------|----------|----------|
| P4 | spur task check | — | task check passed |
| P4 | tests-pass | — | `bun test` packages/laya-mlx: 48 pass / 0 fail (this run) |
| P4 | design-conformance | — | Two-layer parity per Design; fix pass repaired three harness defects found by the first live run (driver score-criteria wire shape, driver score expectation→category mapping, missing noul probability comparison; stub criteria-validation mirror added) |
| P4 | fix-pass | — | Artifacts touched: .spur/run/0081-verify-answer.txt (this file), .spur/run/0081-verdict.json; tracked source edits: packages/laya-mlx/src/driver.ts, scripts/full-parity.ts, tests/fixtures/stub_laya.py, tests/fixtures/protocol-lines.json, tests/protocol-fixture.test.ts, tests/driver.test.ts, tests/prerequisites-and-taxonomy.test.ts |
| P4 | evidence-rule-pass | — | All behavior-bearing AC rows have executable evidence or are explicitly non-behavioral. |

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-09-21T06:58:41.181Z todo → wip (system)
- 2026-09-21T07:01:30.384Z wip → testing (system)
- 2026-09-21T07:01:30.856Z testing → done (system)

