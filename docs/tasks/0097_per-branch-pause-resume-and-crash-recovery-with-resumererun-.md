---
schema_version: 1
name: Per-branch pause, resume, and crash recovery with resumeRerun checks
status: todo
template: feature-impl
created_at: 2026-10-04T21:10:02.281Z
updated_at: "2026-10-04T21:28:35.225Z"
feature_id: C2
parent_wbs: "0092"
priority: P2
tags:
  - dual-workflow-engine
  - fork-join
  - recovery
estimate_hours: 6

dependencies: ["0094", "0095"]
---

## 0097. Per-branch pause, resume, and crash recovery with resumeRerun checks

### Background

Implements: R7 — Per-branch pause and resume preserves completed siblings.

In real-world publishing workflows, one branch may hit a human-in-the-loop review or confirmation gate (`pause: true`) while sibling branches (e.g. static site rebuild, metadata preparation) complete autonomously.

When resuming from pause or recovering from an unexpected interruption, the workflow engine must not blindly re-execute branches that have already succeeded (which would cause duplicate uploads or duplicate messages). This task introduces branch-aware pause, resume, and crash recovery.

### Requirements

- [ ] R1. When any node in a branch encounters pause: true, the branch transitions to status 'paused', non-paused siblings execute to completion, and the parent run transitions to 'paused'.
- [ ] R2. resumeRun in WorkflowService and TransitionFlowDriver queries the branch execution ledger and skips branches already in status 'done', restoring their previously saved variable outputs.
- [ ] R3. For interrupted runs resuming with rerun-enter, branch nodes must declare resumeRerun: true; otherwise resume is refused loudly with FSMError per ADR-025.
- [ ] R4. Out of scope: StateMachineDriver pause/resume (already implemented in baseline).

### Acceptance Criteria

- [ ] AC1 — Per-branch pause and resume preserves completed siblings (req: R1; req: R2; req: R3)

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

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- Feature: C2 (Durable structured fork-join parallel execution)
- Umbrella Task: 0092 (Implement fork/join parallel node execution)
- ADR-025 (Interruption and resume ownership contract)
- Dependencies: 0094 (Branch ledger), 0095 (Scheduler)

### History
