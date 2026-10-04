---
schema_version: 1
name: DAG resume must not re-execute completed nodes
status: todo
template: feature-impl
created_at: 2026-10-04T23:31:01.049Z
updated_at: "2026-10-04T23:32:26.168Z"
feature_id: C3

priority: P1
estimate_hours: 6
---

## 0101. DAG resume must not re-execute completed nodes

### Background

`DagDriver` (task 0100, ADR-034) does not persist per-node completion. `packages/dual-workflow-engine/src/dag.ts:76-88` seeds `nodeStatuses` purely from `dependsOn` at loop start — every node with no prerequisites becomes `ready`, every other node `pending` — and marks only the paused node as `done` from the persisted snapshot. Resume therefore re-dispatches nodes that already completed in the pre-pause segment.

**Verified observation (read-only probe, this session).** A three-node DAG (`a` → `gate(pause: true)` → `b`) run with `MemoryWorkflowPersistenceAdapter`, then resumed via `WorkflowService.resumeRun`:

```
first=paused  second=done  executions={"a":2,"b":1}
transitionsFirst=1  transitionsSecond=3
```

Node `a` executed **twice**. Confirms replay rather than inference.

**Grep evidence.** `rg -n "lifecycle\.(enter|commitHop|pause|done|fail)|saveWorkflowState|savePhase" packages/dual-workflow-engine/src/dag.ts` returns only the terminal calls (`lifecycle.fail` ×2, `lifecycle.pause`, `lifecycle.done`); the DAG loop never records per-node progress, so no resume source of truth exists.

**Requirement violated.** Task 0100 R3 — "resumeRun restarts only incomplete or ready nodes without replaying completed dependencies" — and feature C3 AC `R4 — Durable DAG recovery`. The C2 sibling guarantee for fork/join branches (task 0097) already implements this correctly for `TransitionFlowDriver`, so the two parallel dialects now disagree on resume semantics.

**Fix soundness.** Any DAG node action is re-run on resume today, so non-idempotent actions (publish, upload, send) duplicate their effects. This is the same failure class task 0092's Background describes for the serial engine: silent, untraced duplication.

**Test gap.** `packages/dual-workflow-engine/tests/dag.test.ts` covers pause/resume but its pre-pause node `step1` has no action, so the replay is unobservable; the suite is green while the defect is live.

### Requirements

- [ ] R1. DAG run state records which nodes have completed, durably, so a resumed run does not re-dispatch them.
- [ ] R2. `WorkflowService.resumeRun` on a paused or interrupted DAG re-executes only nodes that had not completed.
- [ ] R3. `DagDriver` refuses to report a run `done` while any node is still `pending` (unreachable node = loud failure, never a silent no-op).
- [ ] R4. FSM and transition-flow resume semantics are unchanged; no new required adapter method is added to `WorkflowPersistenceAdapter`.
- [ ] R5. Out of scope: per-node retry policy, dynamic graph expansion, and `dependencyPolicy: 'any'` sibling-completion semantics (documented residual risk of task 0100).

### Acceptance Criteria

- [ ] AC1 — Durable DAG recovery (req: R1; req: R2)

Task-only checks (not feature scenarios): (a) a node whose action ran before the pause must not run again on resume — assert an execution counter, not just final status; (b) a DAG with an unreachable node must fail with a named reason instead of returning `done`; (c) the existing FSM/transition-flow resume tests stay green.

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-10-04T23:31:21.541Z

#### Q&A entry — 2026-10-04T16:31:00.000Z
- **Q: Is this defect or intended behaviour?**
  - A: Defect. Task 0100 R3 and feature C3 AC `R4 — Durable DAG recovery` both require that completed nodes are not replayed. Both were marked done with the replay live.
- **Q: Why was this not caught by task 0100's tests?**
  - A: `tests/dag.test.ts` pause/resume used a no-action pre-pause node, so a second execution was invisible. Fixing the defect includes closing that assertion gap.

### Design

**WHAT:** Persist DAG node completion and seed resume state from it, then guard run finalization.

**Chosen approach — reuse the shipped durable branch ledger (task 0094).**
`WorkflowPersistenceAdapter` already exposes `saveBranchStart`, `saveBranchFinalize`, and `listRunBranches` in both `DbWorkflowPersistenceAdapter` and `MemoryWorkflowPersistenceAdapter`. Treat one DAG node execution as one ledger row with a reserved `parallel_node` namespace:

```ts
const DAG_LEDGER_NAMESPACE = '__dag__';
await persistence.saveBranchStart(runId, DAG_LEDGER_NAMESPACE, node.id, node.id);
await persistence.saveBranchFinalize(runId, node.id, 'done', durationMs, branchSetVars);
const prior = await persistence.listRunBranches(runId, DAG_LEDGER_NAMESPACE);
```

On loop start, seed `nodeStatuses` from `prior`: `done` rows → `done`; `paused` rows → `done` only when the restored position is that node (it is re-entered), otherwise `pending`; absent rows → the existing `dependsOn` rule. Then `completed` nodes are never re-dispatched, and any later node whose prerequisites are all `done` becomes ready as today.

**Rejected alternative — per-node snapshot through `RunLifecycle`.** Add `lifecycle.nodeCompleted(id, transitionsTaken, vars)` writing a `workflow_states` row carrying `dagCompleted: string[]`, and widen `RunLifecycle.pause` to preserve that key. Rejected: `pause` is a shared write path used by both other dialects, the latest-snapshot read means a pause row silently drops `dagCompleted` unless every writer is changed, and the blast radius covers FSM and transition-flow resume for a DAG-only fix. The ledger channel already exists, is per-run queryable, and needs no shared-path change.

**Naming caveat (accepted).** `workflow_branches` is named for fork/join branches; using it for DAG nodes overloads the term. Recorded here rather than hidden: the columns needed (`run_id`, `branch_id`, `status`, `node`, `output_vars_json`) are a node-execution record exactly, and reusing the table avoids a migration on SQLite and D1. If a second consumer appears, rename the concept in a dedicated change.

**WHERE:**
- Primary: `packages/dual-workflow-engine/src/dag.ts` (seed from ledger, write per-node rows, finalization guard).
- Secondary: `packages/dual-workflow-engine/tests/dag.test.ts` (counter assertions + unreachable-node case).
- Untouched: `src/persistence.ts`, `src/schema-sql.ts`, `src/types.ts` — no adapter or schema change.

**INVARIANTS:**
- No new required method on `WorkflowPersistenceAdapter`; legacy custom adapters keep compiling.
- Ledger writes must not be batched with run finalization — a node completing is progress, not a transition.
- `pause` remains the only writer of the run's paused position.

**ANTI-PATTERNS:**
- Do not mark a node `done` before its action's `saveActionFinalize` has been awaited.
- Do not infer completion from `action_runs` rows; that table is audit-only and queryable only by action id.
- Do not special-case `resumeMode: 'rerun-enter'` by replaying everything; the ADR-025 contract for DAG is still to be defined — if rerun-enter is unsupported, refuse it loudly rather than silently degrading to skip-enter.

**HANDOFF:** Verification must assert an execution counter per node (not just terminal status) and re-run the FSM/transition-flow resume tests to prove R4.

### Plan

1. Extend `tests/dag.test.ts` first: make the pre-pause node's action increment a per-node counter and assert it equals 1 after resume (this fails today); add an unreachable-node case asserting a named failure reason rather than `done`.
2. In `src/dag.ts`, add the `__dag__` ledger namespace constant and write a `saveBranchStart`/`saveBranchFinalize` pair around each node dispatch (start before the action, finalize as `done`/`skipped`/`failed`).
3. Seed `nodeStatuses` from `listRunBranches(runId, '__dag__')` before the first readiness pass, keeping the paused-node restoration and the existing `dependsOn` rule for nodes with no ledger row.
4. Add the finalization guard: after the loop, fail the run with a named reason when any node is still `pending`.
5. Re-run `bun test packages/dual-workflow-engine/tests/`, then `bun run spur-check`, then `bun run build`.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-10-04T23:32:26.168Z backlog → todo (system)

