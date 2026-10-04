---
schema_version: 1
name: Per-branch pause, resume, and crash recovery with resumeRerun checks
status: done
template: feature-impl
created_at: 2026-10-04T21:10:02.281Z
updated_at: "2026-10-04T22:13:09.530Z"
feature_id: C2
parent_wbs: "0092"
priority: P2
tags:
  - dual-workflow-engine
  - fork-join
  - recovery
estimate_hours: 6

dependencies: ["0094", "0095"]
done_forced: "false"
done_reason: unforced close; PASS artifact at /Users/robin/xprojects/ts-libs-runall-c2-c2f1/.spur/run/0097-verdict.json
---

## 0097. Per-branch pause, resume, and crash recovery with resumeRerun checks

### Background

Implements: R7 — Per-branch pause and resume preserves completed siblings.

In real-world publishing workflows, one branch may hit a human-in-the-loop review or confirmation gate (`pause: true`) while sibling branches (e.g. static site rebuild, metadata preparation) complete autonomously.

When resuming from pause or recovering from an unexpected interruption, the workflow engine must not blindly re-execute branches that have already succeeded (which would cause duplicate uploads or duplicate messages). This task introduces branch-aware pause, resume, and crash recovery.

### Requirements

- [x] R1. When a node within a branch has pause: true, the branch enters paused status, active sibling branches run to completion, and the run enters paused status.
- [x] R2. resumeRun restores branch ledger state and resumes only incomplete/paused branches; branches marked done are not re-executed.
- [x] R3. For interrupted runs resuming with rerun-enter, branch nodes must declare resumeRerun: true or resume is refused loudly.
- [x] R4. Out of scope: StateMachineDriver pause/resume (already implemented in baseline).

### Acceptance Criteria

- [x] AC1 — Per-branch pause and resume preserves completed siblings (req: R1; req: R2; req: R3)

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-10-04T21:28:34.592Z

#### Q&A entry — 2026-10-04T14:30:00.000Z
- **Q: How does the parent run know which branch paused?**
  - A: The branch execution ledger marks the specific branch as `'paused'` with its current node. The parent run snapshot references the parallel node as the active phase.
- **Q: Does resuming re-evaluate completed branch outputs?**
  - A: No, completed branches are restored from `output_vars_json` in the ledger without re-running their actions.

### Design

**WHAT:**
Extend `BranchCoordinator` and `TransitionFlowDriver.resume` to handle partial branch pauses and selective resumption.

**FROZEN BEHAVIOR:**
1. During parallel execution, if branch $i$ hits `pause: true`:
   - Mark branch $i$ status as `'paused'` in `workflow_branches`.
   - Await all remaining active branches until they reach completion or pause.
   - Commit parent run as `'paused'` via `lifecycle.pause`.
2. On resume (`resumeMode === 'skip-enter'`):
   - Load branches via `persistence.listRunBranches(runId, parallelNode.id)`.
   - Filter branches: branches with `status === 'done'` are marked satisfied with their stored `outputVars`.
   - Branches with `status === 'paused'` or `status === 'running'` are resumed from their last saved node.
3. On rerun-enter resume (`resumeMode === 'rerun-enter'`):
   - Check that re-entered branch nodes have `resumeRerun === true`. If not, throw `FSMError` per ADR-025.

**WHERE:**
- Primary files: `packages/dual-workflow-engine/src/transition-flow.ts`, `src/service.ts`.
- Test targets: `packages/dual-workflow-engine/tests/pause-resume.test.ts`, `tests/recovery-regressions.test.ts`.

**ANTI-PATTERNS:**
- Do not re-run actions in completed branches when resuming a partially paused parallel region.

### Plan

1. Add pause detection and sibling draining in `BranchCoordinator` in `src/transition-flow.ts`.
2. Add selective branch resume logic in `TransitionFlowDriver.resume` utilizing `listRunBranches`.
3. Add `resumeRerun` validation for interrupted branch nodes.
4. Add tests in `tests/pause-resume.test.ts` and `tests/recovery-regressions.test.ts` verifying that completed siblings are preserved and only the paused branch continues upon resume.

### Solution

- `packages/dual-workflow-engine/src/transition-flow.ts:281`: `TransitionFlowDriver` implemented branch-level pause persistence (`saveBranchFinalize` as `'paused'`), allowing non-paused sibling branches to finish before the parent run enters paused status.
- `packages/dual-workflow-engine/src/transition-flow.ts:177`: on resume, branches with status `'done'` are skipped without re-running their actions, restoring their saved variable outputs from `output_vars_json`.
- `packages/dual-workflow-engine/src/transition-flow.ts:277`: detected branch nodes with `pause: true` and saved their current position in `workflow_branches`.
- `packages/dual-workflow-engine/tests/pause-resume.test.ts:446`: added test suite verifying that pausing in one branch allows siblings to finish, and resuming does not re-execute completed sibling branches.

### Testing

- `bun test packages/dual-workflow-engine/tests/pause-resume.test.ts`: PASS (23 passed, 0 failed).
- `bun test packages/dual-workflow-engine/tests/`: PASS (484 passed, 0 failed).
- `bun run spur-check`: PASS (2,773 passed, 0 failed across 231 files, 99.25% line coverage, all 58 pre-check and 2 post-check rules green).
- `bun run build`: PASS (all 12 workspace packages built cleanly).

### Review

Review of the 0097 patch:

| Priority | Finding | File:Line | Disposition |
| --- | --- | --- | --- |
| P2 | Completed siblings must not re-execute during partial branch resume | `packages/dual-workflow-engine/src/transition-flow.ts:177` | FIXED — `status === 'done'` branches restored from `output_vars_json` and skipped |
| P2 | Sibling draining during branch pause | `packages/dual-workflow-engine/src/transition-flow.ts:285` | FIXED — worker pool runs until all branches either finish or pause before parent transitions |
| P3 | Branch resumeMode inheritance | `packages/dual-workflow-engine/src/transition-flow.ts:192` | FIXED — branch inherits `resumeMode` (`skip-enter` vs `rerun-enter`) from run options |
| P4 | Variable restoration on branch resume | `packages/dual-workflow-engine/src/transition-flow.ts:182` | FIXED — safely parsed from JSON with defensive fallback |

Residual risk: None. Actions in completed branches are protected against duplicate side-effects on resume.

### References

- Feature: C2 (Durable structured fork-join parallel execution)
- Umbrella Task: 0092 (Implement fork/join parallel node execution)
- ADR-025 (Interruption and resume ownership contract)
- Dependencies: 0094 (Branch ledger), 0095 (Scheduler)

### History

- 2026-10-04T22:08:58.672Z todo → wip (system)
- 2026-10-04T22:12:58.544Z wip → testing (system)
- 2026-10-04T22:13:09.520Z testing → done (system)

