---
schema_version: 1
name: DAG resume must not re-execute completed nodes
status: done
template: feature-impl
created_at: 2026-10-04T23:31:01.049Z
updated_at: "2026-10-07T21:52:28.544Z"
feature_id: C3

priority: P1
estimate_hours: 6
done_forced: "false"
done_reason: unforced close; PASS artifact at /Users/robin/xprojects/ts-libs/.spur/memory/evidence/0101-verdict.json
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

- [x] R1. DAG run state records which nodes have completed, durably, so a resumed run does not re-dispatch them.
- [x] R2. `WorkflowService.resumeRun` on a paused or interrupted DAG re-executes only nodes that had not completed.
- [x] R3. `DagDriver` refuses to report a run `done` while any node is still `pending` (unreachable node = loud failure, never a silent no-op).
- [x] R4. FSM and transition-flow resume semantics are unchanged; no new required adapter method is added to `WorkflowPersistenceAdapter`.
- [x] R5. Out of scope: per-node retry policy, dynamic graph expansion, and `dependencyPolicy: 'any'` sibling-completion semantics (documented residual risk of task 0100).

### Acceptance Criteria

- [x] AC1 — Durable DAG recovery (req: R1; req: R2)

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

DAG completion uses the existing __dag__ branch ledger at packages/dual-workflow-engine/src/dag.ts:226-258,460-470 and an unreachable-node finalization guard at line 595. No new adapter method was introduced. Tasks 0104/0105 intentionally replace the historical snapshot-as-done shortcut and wave loop: pause acknowledgement now uses actual paused ledger rows and nodes publish readiness only after durable settlement. packages/dual-workflow-engine/tests/dag.test.ts:151 pins counters and line 183 pins loud failure; packages/dual-workflow-engine/tests/recovery-regressions.test.ts:161 verifies interruption without pause.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | packages/dual-workflow-engine/src/dag.ts:227-258 seeds done/paused statuses and counts from the existing ledger; packages/dual-workflow-engine/tests/dag.test.ts:151 proves execution counters do not replay completed actions. Fresh full gate: 2861 pass, 0 fail. |
| R2 | MET | packages/dual-workflow-engine/src/dag.ts:189-204 and packages/dual-workflow-engine/src/service.ts:222-286 apply service/direct admission and ownership before recovery. packages/dual-workflow-engine/tests/recovery-regressions.test.ts:161,191,449 covers interruption/no-progress refusal; packages/dual-workflow-engine/tests/dag.test.ts:151 covers pause resume. Fresh full gate: 2861 pass, 0 fail. |
| R3 | MET | packages/dual-workflow-engine/src/dag.ts:595-597 rejects stranded pending nodes with named dag-unreachable-nodes; packages/dual-workflow-engine/tests/dag.test.ts:183 regression observes failed result instead of done. Fresh full gate: 2861 pass, 0 fail. |
| R4 | MET | packages/dual-workflow-engine/src/types.ts:563-581 retains the existing branch adapter methods; only DAG production code changed in this pass. Fresh full gate includes FSM and transition-flow resume suites. Fresh full gate: 2861 pass, 0 fail. |
| R5 | MET | packages/dual-workflow-engine/src/dag.ts:328-359 retains all/any policy; dynamic graph expansion and per-node retry policy remain excluded. Fresh full gate: 2861 pass, 0 fail. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| Scenario: R4 — Durable DAG recovery | MET | test | packages/dual-workflow-engine/tests/dag.test.ts:151 proves execution counters; line 183 checks unreachable failure. packages/dual-workflow-engine/tests/recovery-regressions.test.ts:161,428,449 checks interruption and refusal before ownership. Fresh full gate: 2861 pass, 0 fail. |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

#### Review Report — 0101

**Scope:** working tree fallback (no exact task subject tag), restricted to this task's declared source/tests plus immediate callers; source and anchors reread this run.
**Dimensions:** functional, security, efficiency, correctness, usability, architecture.
**Verdict:** PASS

##### Findings

| Priority | Dimension | Location | Finding | Disposition |
| --- | --- | --- | --- | --- |
| P4 | all | packages/dual-workflow-engine/src/dag.ts:121-600 | No open P1-P3 findings: task requirements/AC trace to real-driver tests and the fresh full gate. | ACCEPTED |

##### Functional Traceability

| Req | Status | Evidence |
| --- | --- | --- |
| R1 | MET | packages/dual-workflow-engine/src/dag.ts:227-258 seeds done/paused statuses and counts from the existing ledger; packages/dual-workflow-engine/tests/dag.test.ts:151 proves execution counters do not replay completed actions. |
| R2 | MET | packages/dual-workflow-engine/src/dag.ts:189-204 and packages/dual-workflow-engine/src/service.ts:222-286 apply service/direct admission and ownership before recovery. packages/dual-workflow-engine/tests/recovery-regressions.test.ts:161,191,449 covers interruption/no-progress refusal; packages/dual-workflow-engine/tests/dag.test.ts:151 covers pause resume. |
| R3 | MET | packages/dual-workflow-engine/src/dag.ts:595-597 rejects stranded pending nodes with named dag-unreachable-nodes; packages/dual-workflow-engine/tests/dag.test.ts:183 regression observes failed result instead of done. |
| R4 | MET | packages/dual-workflow-engine/src/types.ts:563-581 retains the existing branch adapter methods; only DAG production code changed in this pass. Fresh full gate includes FSM and transition-flow resume suites. |
| R5 | MET | packages/dual-workflow-engine/src/dag.ts:328-359 retains all/any policy; dynamic graph expansion and per-node retry policy remain excluded. |

##### SECUA Quality

Replay admission remains before ownership claim; both entry points share the same helper. Nodes reserve admission once, publish only durable completion, and drained errors keep their reasons. No secrets, unbounded new buffers, new dependencies, suppressions or skipped tests were introduced. Existing fail/continue and lifecycle error composition remain intact. Historical accepted observations are maintained by the design: no timeout for nonsettling work, action failures use fail-policy results, and variable collisions follow durable live completion / stable topological recovery ordering.

##### Architectural Depth

No candidates: DAG validation, scheduling, ledger recovery and lifecycle finalization retain their existing seams. No production FSM/transition-flow or adapter-contract changes; ADR-034 remains satisfied. Historical wave and snapshot-shortcut descriptions are superseded explicitly in Solution by tasks 0104/0105. Driver dryRun suppression retains the shared terminal-pause write contract; ledger writes remain separate from action effects with marked at-least-once replay, as documented in README.

**Validation:** bun run spur-check exit 0, 2861 pass / 0 fail, 58 pre / 2 post rules; all package builds exit 0. Receipts .spur/run/c3-verifyall/spur-check.log and build.log.

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-10-04T23:32:26.168Z backlog → todo (system)
- 2026-10-04T23:34:07.404Z todo → wip (system)
- 2026-10-04T23:45:55.571Z wip → testing (system)
- 2026-10-04T23:46:13.578Z testing → done (system)

