---
schema_version: 1
name: Document the package surface against the hosted SDK reference
status: done
template: feature-impl
created_at: 2026-09-21T03:11:42.102Z
updated_at: "2026-09-21T07:03:36.390Z"
feature_id: J
priority: P2
tags:
  - laya-mlx
  - docs
estimate_hours: 3

dependencies: ["0080", "0081"]
---

## 0082. Document the package surface against the hosted SDK reference

### Background

I4 makes the TypeSafe JavaScript SDK API reference the contract of record for the external surface, and I3 promises a downstream user can replace one backend with the other. A reader deciding whether to switch needs to see the two surfaces side by side, including where they deliberately differ.

### Requirements

- [x] R1. The README lists every exported factory, option, and answer field beside the hosted counterpart it mirrors.
- [x] R2. Each intentional divergence is named together with its reason.
- [x] R3. The host prerequisites, the supported runtime version range, and the install command are stated.
- [x] R4. The backend-selection ergonomic is shown from the caller's side, for both names.
- [x] R5. The worker protocol is documented well enough to debug by hand.
- [x] R6. Attribution to the upstream project and the derived revision is present and matches the NOTICE.

### Acceptance Criteria

- [x] AC1 — The package documentation maps its surface onto the hosted SDK reference (req: R1, R2)

Prerequisites, selection examples, protocol notes, and attribution are additionally present (R3, R4, R5, R6).

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

**What.** The package README, written as a substitution guide rather than a feature tour.

**Why a mapping table.** The question a reader arrives with is whether their existing code keeps working. A table from hosted surface to local surface answers that directly, and its gaps are the answer to the follow-up question — what changes. Prose describing the local surface on its own terms would make the reader do that diff themselves.

**Why divergences are named with reasons.** There are only a few, and each is deliberate: the dropped noul confidence, the absent action probability, the host prerequisites, the platform lock. A reader who finds one undocumented reasonably concludes it is a bug and files it. Naming them converts each from a surprise into a decision they can evaluate.

**Why prerequisites are prominent.** This is the only package in the workspace that will not work on an arbitrary host. Burying that below the usage example wastes the reader's time and produces avoidable support traffic.

**Why document the protocol.** The worker is a published file a maintainer can drive from a terminal, and the fastest diagnosis of a misbehaving bridge is to speak to it directly. Documenting it costs a short section and removes the need to read the source to do that.

### Plan

1. Draft the substitution table: hosted surface against local surface, field by field.
2. Write the divergence section, one entry per deliberate difference with its reason.
3. Write the prerequisites section with the version range and install command, above the usage example.
4. Show backend selection from the caller's side for both names.
5. Document the worker protocol with a hand-drivable example.
6. Add the attribution section and confirm it matches the NOTICE.
7. Add the package to the design index and confirm the cross-links resolve.

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
| R1 | MET | `packages/laya-mlx/README.md:52-69` (substitution reference table maps every exported factory, option, and answer field between hosted TypeSafe and local Laya). |
| R2 | MET | `packages/laya-mlx/README.md:71-87` (documents all 4 intentional divergences: noul confidence dropped, action probability dropped, Apple Silicon hardware lock, env isolation). |
| R3 | MET | `packages/laya-mlx/README.md:21-33` (host prerequisites: macOS Apple Silicon, Python 3.10+, supported runtime range `laya-mlx 0.1.x`, `pip install laya-mlx`). |
| R4 | MET | `packages/laya-mlx/README.md:35-50` (shows caller ergonomics for both `'typesafe'` and `'laya-local'` using `createDecisionMaker`). |
| R5 | MET | `packages/laya-mlx/README.md:89-114` (terminal debugging guide demonstrating stdin/stdout JSON Lines interaction and error categories). |
| R6 | MET | `packages/laya-mlx/README.md:13-18,131-137` (attribution to `mizorewww/laya-mlx` at revision `fc1df62828a3fedf4d8229fdac1cbd85f1cdf337`, matching NOTICE). |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC1 | MET | command | `grep -E "Hosted SDK vs Local Driver |
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

- 2026-09-21T07:02:42.080Z todo → wip (system)
- 2026-09-21T07:03:35.876Z wip → testing (system)
- 2026-09-21T07:03:36.390Z testing → done (system)

