---
schema_version: 1
name: TransitionFlowDriver parallel region scheduler, concurrency bounding, and variable isolation
status: done
template: feature-impl
created_at: 2026-10-04T21:10:02.278Z
updated_at: "2026-10-04T22:37:59.233Z"
feature_id: C2
parent_wbs: "0092"
priority: P2
tags:
  - dual-workflow-engine
  - fork-join
  - scheduler
estimate_hours: 8

dependencies: ["0093", "0094"]
done_forced: "false"
done_reason: unforced close; PASS artifact at /Users/robin/xprojects/ts-libs-runall-c2-c2f1/.spur/run/0095-verdict.json
---

## 0095. TransitionFlowDriver parallel region scheduler, concurrency bounding, and variable isolation

### Background

Implements: R2 — Concurrent branch execution overlaps under bounded concurrency; R4 — Collect failure policy allows all branches to complete before recording aggregate failure; R5 — Branch variable isolation and deterministic join merge.

In the current `TransitionFlowDriver`, execution proceeds node-by-node via a single cursor loop. When a parallel region is encountered, the driver must execute all declared branches concurrently without exceeding concurrency limits or corrupting shared runtime variables.

This task implements the in-process parallel region coordinator in `TransitionFlowDriver`. It snapshots parent variables at the fork, executes branches concurrently within a bounded worker queue, collects per-branch variable deltas in isolation, and deterministically combines them at the join barrier.

### Requirements

- [x] R1. TransitionFlowDriver recognizes nodes with type: 'parallel' and launches branch executions concurrently up to concurrencyLimit (default: 4).
- [x] R2. Branch actions receive a frozen copy of parent variables and accumulate isolated setVars deltas that do not leak to sibling branches.
- [x] R3. Under failurePolicy 'collect', all branches execute to completion, their variable deltas are combined deterministically in branch declaration order, and the join node is entered.
- [x] R4. Variable collision rule: if multiple branches set the same variable key, strict declaration order determines the final value (last declaration wins or explicit error if configured).
- [x] R5. Out of scope: Process-group SIGTERM/SIGKILL escalation (owned by task 0096) and pause/resume suspension (owned by task 0097).

### Acceptance Criteria

- [x] AC1 — Concurrent branch execution overlaps under bounded concurrency (req: R1)
- [x] AC2 — Collect failure policy allows all branches to complete before recording aggregate failure (req: R3)
- [x] AC3 — Branch variable isolation and deterministic join merge (req: R2; req: R3; req: R4)

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-10-04T21:28:24.049Z

#### Q&A entry — 2026-10-04T14:30:00.000Z
- **Q: How is concurrency bounded?**
  - A: Using an in-memory queue or semaphore that caps active in-flight promises to `concurrencyLimit` (from node definition, or default 4).
- **Q: Does a branch failure immediately fail the run under 'collect'?**
  - A: No. Under `failurePolicy: 'collect'`, all sibling branches are allowed to finish and record their results before the join node evaluates the aggregate outcome.

### Design

**WHAT:**
Implement `BranchCoordinator` in `src/transition-flow.ts` to coordinate parallel branch execution.

**FROZEN BEHAVIOR & INTERFACES:**
```ts
interface BranchExecutionResult {
    readonly branchId: string;
    readonly status: BranchStatus;
    readonly outputVars: Vars;
    readonly error?: string;
}

class BranchCoordinator {
    constructor(
        private readonly parallelNode: FlowParallelNodeDef,
        private readonly deps: ActionStepDeps,
        private readonly concurrencyLimit: number,
    ) {}

    async executeBranches(
        baseVars: Vars,
        env: Record<string, string>,
    ): Promise<BranchExecutionResult[]>;
}
```

**WHERE:**
- Primary files: `packages/dual-workflow-engine/src/transition-flow.ts`, `src/action-step.ts`.
- Test targets: `packages/dual-workflow-engine/tests/transition-flow.test.ts`.

**ANTI-PATTERNS:**
- Do not use unbounded `Promise.all` which could spawn dozens of subprocesses simultaneously.
- Do not let a branch write directly into `vars` of the parent driver loop during execution.

**HANDOFF TO DOWNSTREAM:**
Provides parallel execution backbone to task 0096 (cancellation), 0097 (pause/resume), and 0098 (observability).

### Plan

1. Implement `BranchCoordinator` in `src/transition-flow.ts` with bounded promise concurrency.
2. In `TransitionFlowDriver.loop`, intercept `current.type === 'parallel'` and delegate to `BranchCoordinator`.
3. Implement variable isolation and declaration-order delta merging at the join barrier.
4. Add tests in `tests/transition-flow.test.ts` verifying concurrent overlapping execution, concurrency limits, and variable isolation.

### Solution

- `packages/dual-workflow-engine/src/transition-flow.ts:23`: `TransitionFlowDriver` implemented parallel region execution using bounded concurrency, variable snapshotting at fork, and declaration-order delta merging at join.
- `packages/dual-workflow-engine/src/transition-flow.ts:352`: implemented `runWithConcurrencyLimit` worker pool bounding concurrent branch execution without third-party dependencies.
- `packages/dual-workflow-engine/tests/transition-flow.test.ts:430`: added test suite verifying overlapping concurrent execution, variable isolation, concurrency limits, and collect failure policy.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/dual-workflow-engine/src/transition-flow.ts:150` — concurrencyLimit ?? 4 bounding active branches |
| R2 | MET | `packages/dual-workflow-engine/src/transition-flow.ts:245` — per-branch isolated branchVars/branchSetVars accumulation via mergeSetVars |
| R3 | MET | `packages/dual-workflow-engine/src/transition-flow.ts:246` — collect policy merges deltas deterministically; test proof at `packages/dual-workflow-engine/tests/transition-flow.test.ts:608` |
| R4 | MET | `packages/dual-workflow-engine/src/transition-flow.ts:246` — declaration-order mergeSetVars join; collision rule per merge order |
| R5 | MET | Out-of-scope row (SIGTERM escalation → 0096, pause/resume → 0097); boundary confirmed in commit 29f83335 |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| R2 — Concurrent branch execution overlaps under bounded concurrency | MET | test | `packages/dual-workflow-engine/tests/transition-flow.test.ts:414` ('runs parallel branches concurrently') and :549 ('enforces concurrencyLimit') — anchors corrected from in-body :430 |
| R4 — Collect failure policy allows all branches to complete before recording aggregate failure | MET | test | `packages/dual-workflow-engine/tests/transition-flow.test.ts:608` — anchor corrected from :580 (wrong test body) |
| R5 — Branch variable isolation and deterministic join merge | MET | test | `packages/dual-workflow-engine/tests/transition-flow.test.ts:478` — anchor corrected from in-body :480 |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

Review of the 0095 patch:

| Priority | Finding | File:Line | Disposition |
| --- | --- | --- | --- |
| P2 | Worker pool must avoid non-null assertions and unbounded queue growth | `packages/dual-workflow-engine/src/transition-flow.ts:352` | FIXED — `runWithConcurrencyLimit` bounds worker count to `Math.min(limit, items.length)` and checks index boundaries safely |
| P2 | Variable collision across concurrent branches | `packages/dual-workflow-engine/src/transition-flow.ts:250` | FIXED — deltas merged strictly in declaration order of branches |
| P3 | Branch loop termination at join node | `packages/dual-workflow-engine/src/transition-flow.ts:182` | FIXED — `while (branchCurrent && branchCurrent.id !== parallelNode.join)` terminates cleanly at join barrier |
| P4 | Dry-run mode support for parallel nodes | `packages/dual-workflow-engine/src/transition-flow.ts:149` | FIXED — dryRun skips action execution and advances directly to join node |

Residual risk: None. Concurrency is strictly bounded and variables are completely isolated during execution.

### References

- Feature: C2 (Durable structured fork-join parallel execution)
- Umbrella Task: 0092 (Implement fork/join parallel node execution)
- Dependencies: 0093 (Schema/types), 0094 (Persistence ledger)

### History

- 2026-10-04T22:00:20.652Z todo → wip (system)
- 2026-10-04T22:04:16.183Z wip → testing (system)
- 2026-10-04T22:04:28.626Z testing → done (system)

