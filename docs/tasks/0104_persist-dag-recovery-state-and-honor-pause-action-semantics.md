---
schema_version: 1
name: Persist DAG recovery state and honor pause action semantics
status: todo
template: feature-impl
created_at: 2026-10-07T18:45:34.968Z
updated_at: "2026-10-07T19:15:47.619Z"
feature_id: C3

priority: P1
ac_numbering: task-local
ac_altitude: task-local
dependencies: ["0101"]
estimate_hours: 8
---

## 0104. Persist DAG recovery state and honor pause action semantics

### Background

The 2026-10-07 package review identified two remaining DAG defects. Current dag.ts reads snapshots and the __dag__ ledger but writes a snapshot only through lifecycle.pause. WorkflowService.resumeRun therefore refuses a non-paused interrupted run with no current state. Completed branch finalization currently omits outputVars. The pause branch precedes runActionStep; a fresh real-service memory-adapter probe during this batch returned paused → done with zero action executions and left the acknowledged node's ledger status paused.

Task 0101 is done and its ledger-based no-replay behavior is present. It does not restore outputs, admit interrupted DAGs without pause, or implement per-node rerun safety. The generic service safety check covers only snapshot.state. DagDriver.run and DagDriver.resume share one loop; direct resume and service resume must use the same per-node admission policy.

**Refine corrections (2026-10-07)**

- “Persist reconstructible progress” without a write order → ledger and snapshots are independent adapter writes → freeze an initial snapshot before new node work, a ledger-derived anchor for legacy interrupted runs without snapshots, and terminal ledger output deltas as the recovery source; no promise of an atomic action/ledger transaction.
- “Explicit deterministic conflict policy” without a decision → node declaration can be non-topological and timestamps can tie → merge durable deltas in stable topological order (declaration-order tie break); caller overrides win. Freeze recovery-only collision behavior.
- “Restore transition counts” without a counting unit → branch rows are upserted, not an attempt history → DAG transitionsTaken counts distinct action-complete done/paused nodes; acknowledgement/rerun does not double-count a node.
- Anchor-only rerun check → multiple unfinished ledger rows can exist → check every previously running/pending action before ownership claim and again in direct-driver admission; never use an anchor as permission to replay other actions.
- “Track multiple pauses” without acknowledgement rules → current acknowledged rows remain paused and can alternate → acknowledge one paused node per resume in declaration order, persist done, and surface the next pending pause once.
- “No new API planned” left an adapter/schema fallback open → existing outputVars and snapshot methods suffice → freeze no new adapter methods, schema migrations, shared pause payload changes, or public flags.
- Checkbox AC and missing environment/dependency decisions → bind Gherkin scenarios, add completed task 0101 as prerequisite, and require frozen-lockfile dependency alignment at implementation step 0.

Environment: Bun 1.3.14; installed zod 4.2.1 versus locked 4.4.3. Concurrency: one main worktree, no wip tasks, unrelated infra/utils edits and review artifacts to preserve. Scheduling changes belong to 0105 and failure draining to 0103.

### Requirements

- [ ] R1. Fresh non-dry DAG execution saves a valid node anchor before node work. Resume restores done/paused node output deltas from the __dag__ ledger without replaying completed actions, and restores distinct completed-node transitionsTaken without requiring a prior pause.
- [ ] R2. A pause node's successful or continue-policy action, setVars, action audit, and paused branch record finish before run pause. Default skip-enter acknowledges the current paused node once; marked rerun-enter executes that node once more and continues past its pause.
- [ ] R3. Every previously unfinished action replay requires its own resumeRerun: true and rerun-enter mode. Unsafe service admission fails before claiming ownership or invoking actions. Multiple paused nodes are acknowledged individually without alternating or replaying unrelated done nodes.
- [ ] R4. Preserve ownership CAS/finalization fences, conditional skips, failure policy, DAG dry-run suppression of node-ledger/checkpoint writes, and FSM/transition-flow behavior. Use existing adapter methods and test real memory and SQLite persistence.

Out of scope: exactly-once external effects, live-owner cancellation, fencing all ledger writes, atomic action-plus-ledger transactions, reconstructing outputs never persisted by old releases, dynamic graphs, scheduler redesign (0105), failure drain redesign (0103), new APIs/dependencies/schema migrations.

### Acceptance Criteria

```gherkin
Feature: Durable DAG progress and completed pause actions

  Scenario: AC1 — Interruption without pause restores DAG progress (req: R1)
    Given a dead-owner fixture with a completed producer and a running marked dependent in the real ledger
    And the definition lists a dependent before its producer
    And the persisted anchor exists or legacy progress has no snapshot
    When a fresh WorkflowService resumes the interrupted run
    Then the producer is not replayed and its durable variables reach the dependent
    And caller overrides win and transitionsTaken counts each completed node once
    And resuming needs no previous explicit pause

  Scenario: AC2 — Pause actions execute before acknowledgement (req: R2)
    Given a pause node with a counted action producing variables and deferred audit persistence
    When run pauses and is resumed with skip-enter
    Then the action and evidence finish before the pause result
    And the action runs once and its acknowledged row becomes done before downstream dispatch
    And permitted rerun-enter runs it once more without immediately pausing it again

  Scenario: AC3 — Multiple pauses and unsafe interrupted nodes are handled (req: R3)
    Given two ready pause nodes and a snapshot anchor that does not authorize another running action
    When successive resumes acknowledge the pauses
    Then each pause is surfaced and acknowledged once without replaying unrelated completed actions
    And any unsafe unfinished action is refused before service ownership claim or host invocation
    And the direct driver enforces the same replay rule

  Scenario: AC4 — Recovery remains adapter-consistent (req: R4)
    Given real memory and SQLite adapters and deferred persistence fault cases
    When executing run, pause, interruption recovery, and competing service resumes
    Then completed output rows and ownership outcomes agree across adapters
    And dryRun makes no node-ledger or recovery-checkpoint writes
    And existing FSM and transition-flow tests, the canonical gate, and build pass

  Scenario: AC5 — Recovery delta ordering and legacy rows are explicit (req: R1; R4)
    Given conflicting string deltas in durably completed nodes and a legacy row with null output_vars_json
    When a fresh service restores the DAG
    Then stable topological ordering determines collisions and caller variables win
    And null legacy output is empty and malformed stored deltas fail loudly
    And recovery never reruns completed actions to reconstruct missing historical output
```

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-10-07T19:13:28.678Z

- Decision: existing snapshot/branch methods suffice; no schema, adapter, or shared pause payload extension.
- Decision: ledger terminal deltas are authoritative; recovery uses stable topological collision order and caller overrides last. Live independent collisions remain completion-ordered.
- Decision: DAG transition counts measure distinct completed nodes, including paused action-complete nodes; acknowledgement/rerun does not double-count.
- Decision: acknowledge one paused node per resume; rerun-enter requires its marker and bypasses that pause once.
- Decision: previously unfinished actions require rerun-enter and their own safety marker; the snapshot anchor cannot authorize other actions.
- Decision: external exactly-once effects and stale-owner ledger fencing are deferred outside this task. Recovery assumes the prior owner has stopped.
- Decision: 0101 is the completed prerequisite; 0103 owns draining and 0105 consumes this recovery contract.

### Design

No new public API. WHAT/WHY: make existing ledger progress resumable without an explicit pause and align pause with post-action semantics. WHERE: packages/dual-workflow-engine/src/dag.ts and its service admission branch in src/service.ts; tests/dag.test.ts and tests/recovery-regressions.test.ts; README.md documents DAG recovery variable collisions and distinct-node counting. Existing persistence methods suffice; do not edit types.ts, schema-sql.ts, adapter contracts, or RunLifecycle.pause.

Frozen persistence/recovery contract:
1. On a fresh non-dry run, saveWorkflowState(runId, workflow.nodes[0].id, {effectiveVars: initialVars, transitionsTaken: 0}) before saveBranchStart/guards/actions. A workflow must already have passed normal definition validation. The anchor is a declared node for service admission, never evidence that that node completed. For an interrupted DAG with no snapshot but existing __dag__ rows, service admission derives an anchor from the first paused row in declaration order, otherwise the first unfinished declared row, otherwise the first declared node. Do not apply the generic no-state refusal to that recoverable DAG. With neither snapshot nor DAG ledger rows, retain the existing refusal. After the successful ownership claim, persist the derived anchor before dispatch; the direct driver uses the same fallback. No-state admission reads progress but does not write it before the CAS.
2. Keep __dag__ as the branch namespace. Save only the node's accepted string setVars delta through saveBranchFinalize outputVars, with done/paused status after the awaited action audit. No-action nodes store an empty delta. Failed/condition-cancelled nodes contribute no completed output. Only publish a settled node status/vars to dependent work after its branch write succeeds.
3. Restore statuses from all ledger rows: done stays done; cancelled stays skipped; failed stays failed; paused means action complete but acknowledgement outstanding; running/pending means previously started/unfinished; absent means never started. Remove the snapshot.state-is-done shortcut.
4. Build a stable topological ordering using declared dependencies, choosing declaration order among equally ready nodes. Recovery variable precedence: workflow defaults, snapshot effectiveVars baseline, accepted deltas from done/paused rows in this topological order, then caller options.vars. Null historical output_vars_json is an empty delta; malformed JSON/non-object/non-string entries cause WorkflowResumeError before execution. Recovery collision ordering is deterministic; live independent-node collisions retain current completion-order behavior and are documented. Do not replay old completed actions to recover missing historical values.
5. Define DAG transitionsTaken as the number of distinct action-complete done/paused nodes, including no-action completed nodes, excluding cancelled/failed rows. A paused acknowledgement and explicit rerun of its already-complete action do not count that node twice. Recompute from ledger; dryRun uses the same logical counting in memory.
6. Service DAG admission uses a package-internal assertDagResumeAllowed helper exported from dag.ts for service.ts only, not index.ts. Invoke it before claimRunOwnership, replacing the generic anchor-only check for DAG; keep generic checks unchanged for other kinds. The driver also calls it before dispatch so direct DagDriver.resume is covered. For direct resume resolve absent resumeMode from the run's paused/interrupted status. Check every previously running/pending node with an action: it may replay only in rerun-enter with its own resumeRerun: true; otherwise throw FSMError naming that node. Never-started nodes need no marker. For a paused anchor, rerun-enter requires that anchor's marker; done non-paused rows never replay merely because the anchor names them. No-action unfinished nodes can continue safely.
7. For paused runs, acknowledge only snapshot.state when it has a paused row. Default skip-enter saves that row done with its existing delta before allowing dependents. Explicit rerun-enter re-executes that marked pause action once, updates its delta, saves done, and bypasses its pause once. Other paused rows remain barriers; choose the next outstanding pause in declaration order and call existing lifecycle.pause after admitted work drains. For interrupted recovery with paused rows, choose the first paused row in declaration order as the acknowledgement target; use the same mode/marker rules. Acknowledgement is idempotent across a crash because done rows are never replayed.
8. Move the ordinary pause check after successful/continue action execution, delta merge, awaited audit, and terminal branch write. Action fail and thrown guard/persistence exceptions still outrank pause. Preserve task 0103's settlement contract without redesigning it. In service DAG dispatch, pass caller vars separately from snapshot restoration rather than feeding stale restoredVars back as if it were a caller override; the driver owns the above precedence. Other modes retain mergedOptions restoration.
9. Snapshot and ledger writes are separate. Crash after an external action but before a terminal branch write leaves unfinished work requiring marked replay; this is at-least-once recovery, not exactly-once. No atomic cross-table extension or change to common pause payload. Operators must stop/reconcile the previous owner before resuming; current ledger writes have no per-owner fence.

Tests use real WorkflowService/DagDriver/RunLifecycle and MemoryWorkflowPersistenceAdapter plus DbWorkflowPersistenceAdapter over createDbAdapter({driver: 'bun-sqlite', url: ':memory:'}). For interrupted cases create truthful dead-owner fixtures using public adapter methods; do not interrupt a still-live blocked action and call that crash recovery. Wrap only individual writes to delay/fail them; inspect real rows and counters, release all deferred gates in cleanup, and close SQLite handles. Test initial snapshot-before-action, durable output recovery including non-topological declaration and collisions, null/corrupt legacy output, caller override, counts, audit-before-pause, two independent pauses and a later pause, direct-driver entry, unsafe non-anchor replay refusal before CAS, competing CAS claims, and persistence failure windows.

Prerequisites: completed 0101 supplies the __dag__ no-replay baseline; no re-ownership of that fix. 0105 consumes these persisted-status/output and pause rules; add it as a downstream dependency on this task. 0103 separately owns error draining. Environment step 0 aligns installed dependencies to bun.lock. One main worktree/no wip conflicts; preserve unrelated changes.

### Plan

- [ ] 0. Run bun install --frozen-lockfile; confirm Bun 1.3.14 / zod 4.4.3, unchanged manifests/lockfile, and no new same-file work.
- [ ] 1. Add real-service action-plus-pause and dead-owner no-prior-pause recovery regressions; assert node counters and actual ledger/snapshot state (R1, R2).
- [ ] 2. Persist an initial anchor and terminal node deltas, and admit legacy no-snapshot interrupted runs from existing ledger rows; restore statuses, stable topological delta precedence, caller overrides, and distinct-node counts (R1).
- [ ] 3. Add shared DAG-only admission before service CAS and direct-driver dispatch; test unsafe non-anchor nodes, skip-enter refusal for unfinished actions, and marked reruns (R3).
- [ ] 4. Move pause after evidence, implement one-node acknowledgement and one-shot permitted rerun, and test independent/multi-stage pauses without repeat acknowledgement (R2, R3).
- [ ] 5. Exercise recovery and failure windows with real memory/SQLite adapters, legacy/corrupt output, CAS competition, dryRun, and unchanged FSM/transition-flow behavior; document collision/count semantics (R1–R4).
- [ ] 6. Run bun run spur-check and bun run build; preserve unrelated edits and check the final diff (R4).

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- docs/00_ADR.md:403 — ADR-025 ownership and rerun safety.
- docs/00_ADR.md:664 — ADR-034 DAG mode.
- Feature C3; completed task 0101; task 0103 draining; dependent task 0105 scheduling.
- packages/dual-workflow-engine/src/dag.ts:77 — snapshot restoration; :88 — ledger seed; :205 — premature pause; :254 — output-less finalization.
- packages/dual-workflow-engine/src/service.ts:226 — no-state refusal; :235 — anchor-only safety; :249 — CAS; :277 — DAG resume dispatch.
- packages/dual-workflow-engine/src/run-lifecycle.ts:393 — pause snapshot data is recreated.
- packages/dual-workflow-engine/tests/dag.test.ts and tests/recovery-regressions.test.ts — real driver/service observability; tests/persistence.test.ts — SQLite setup.
- Audit 2026-10-07: real-service pause probe actions=0, pause→done, acknowledged ledger remains paused; source confirms missing ordinary checkpoints/outputs.
- Environment/concurrency 2026-10-07: Bun 1.3.14, installed zod 4.2.1 vs lock 4.4.3; one main worktree, no wip tasks.
- Batch dead-owner probe: completed producer output + running dependent, no snapshot → WorkflowResumeError before claim; specified legacy fallback closes that observed case.

### History

- 2026-10-07T18:47:00.885Z backlog → todo (system)

