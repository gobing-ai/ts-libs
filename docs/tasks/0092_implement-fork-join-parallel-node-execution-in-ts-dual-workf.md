---
schema_version: 1
name: Implement fork/join parallel node execution in ts-dual-workflow-engine
status: todo
template: feature-impl
created_at: 2026-10-04T06:57:19.806Z
updated_at: "2026-10-04T21:27:38.547Z"
feature_id: C2

dependencies: ["0093", "0094", "0095", "0096", "0097", "0098"]
---

## 0092. Implement fork/join parallel node execution in ts-dual-workflow-engine

### Background

`@gobing-ai/ts-dual-workflow-engine` declares `type?: 'action' | 'gate' | 'parallel' | 'decision'` on `FlowNodeDef` (`src/types.ts:125`, `src/schema.ts:139`), but `TransitionFlowDriver` currently evaluates only the first matching outbound edge and advances sequentially with a single cursor. The `parallel` type validates, renders as a fork in Mermaid, but silently no-ops into sequential execution.

Downstream consumers (such as knowledge-kit publishing pipelines) are forced to fake concurrency inside custom shell actions or scripts (`kk executor fan-out` / `fan-in`). This causes:
- **Serialization by construction:** Independent transports (e.g. podcast feed, Xiaohongshu, WeChat) must be daisy-chained sequentially, summing their wall-clock latencies.
- **Invisible concurrency:** Concurrency hidden inside shell scripts deprives the workflow engine of per-branch routing, tracing, timing, and recovery awareness.
- **Fragile recovery:** A failure or crash in one channel can leave the entire pipeline in an ambiguous or unresumable state.

This umbrella task coordinates the delivery of durable, bounded structured fork-join parallel node execution in `transition-flow` workflows under Feature C2. It leaves state-machine (FSM) workflows strictly sequential, while providing transition-flow with first-class branch scheduling, variable isolation, process-group cancellation, and restart-safe persistence.

### Requirements

- [ ] R1. Transition-flow schema and semantic validation support structured fork-join parallel definitions and fail loud on unexecutable structures.
- [ ] R2. Durable persistence tracks individual branch executions with atomic start, completion, and join commits under ownership fencing.
- [ ] R3. TransitionFlowDriver executes declared parallel branches concurrently up to a configured concurrency bound.
- [ ] R4. Active child processes and branch runners are terminated cleanly via AbortSignal and ts-runtime process-group cleanup under fail-fast or run cancellation.
- [ ] R5. Branch variable scopes are isolated during execution and combined deterministically at join in declaration order.
- [ ] R6. Pausing within a branch suspends the parallel barrier while allowing siblings to finish, and resuming restarts only incomplete branches.
- [ ] R7. Observability emits branch-scoped events and traces, while existing serial workflows and FSM runs maintain 100% backward compatibility.

### Acceptance Criteria

- [ ] AC1 — Validation accepts structured fork-join and rejects invalid parallel definitions (req: R1)
- [ ] AC2 — Concurrent branch execution overlaps under bounded concurrency (req: R3)
- [ ] AC3 — Fail-fast cancels active siblings with process-group cleanup (req: R4)
- [ ] AC4 — Collect failure policy allows all branches to complete before recording aggregate failure (req: R3; req: R4)
- [ ] AC5 — Branch variable isolation and deterministic join merge (req: R5)
- [ ] AC6 — Persisted branch execution ledger and idempotent join activation (req: R2)
- [ ] AC7 — Per-branch pause and resume preserves completed siblings (req: R6)
- [ ] AC8 — Existing serial workflows and FSM runs remain unchanged (req: R7)

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-10-04T21:09:29.382Z

#### Q&A entry — 2026-10-04T14:10:00.000Z
- **Q: Does this change FSM (state-machine) execution?**
  - A: No. `StateMachineDriver` remains single-cursor, sequential, and unaffected. Concurrency is added only to `transition-flow`.
- **Q: Why structured fork-join instead of general static DAG scheduling?**
  - A: Structured fork-join directly solves the primary production use case (concurrent multi-channel publishing) with clear barrier semantics and lower blast radius. General static DAG scheduling is factored into Feature C3.
- **Q: How are variable write conflicts resolved across concurrent branches?**
  - A: Branches read a frozen fork-time snapshot of variables and accumulate local `setVars` deltas. At join, deltas are merged deterministically in branch declaration order, and key collisions can be configured to fail or follow declaration order.
- **Q: Are nested parallel regions supported in v1?**
  - A: No. Nested parallel regions are explicitly rejected during schema validation in v1 to keep recovery and failure coordination bounded.

### Design

**Model:**
Extend `TransitionFlowDriver` to recognize structured parallel regions. When reaching a node with `type: parallel`, the driver spawns branch executions for all declared outbound paths. Execution of branches is governed by a local coordinator with a configurable concurrency bound (default: 4). The coordinator waits for branch completion according to `joinPolicy` ('all') and `failurePolicy` ('collect' | 'fail-fast') before taking the transition to the join node.

**Coordinator vs Driver Ownership:**
The parent `RunLifecycle` retains single ownership of the overall run status, OTel span, and finalization fence. Branch executions are sub-lifecycles that write to a branch ledger but do not finalize the parent run row.

**Persistence:**
Introduce a branch execution ledger (`workflow_branches` table or equivalent JSON structure on SQLite and D1). Each branch execution logs its start, completion status, duration, and produced variable deltas. Branch completion and join activation are committed in atomic batches using ADR-020 transactions.

**Cancellation:**
Wire an `AbortController` per branch. Pass `signal: AbortSignal` into `ActionRunContext` and `GuardContext`. For `shell` actions, forward the signal directly to `ts-runtime`'s `ProcessExecutor.run({ signal, ... })`, activating Unix process-group SIGTERM/SIGKILL termination. Under `fail-fast`, the first branch failure aborts active sibling controllers.

**Pause & Resume Recovery:**
If a branch node declares `pause: true`, the coordinator allows other branches to complete, persists the branch ledger state, and transitions the parent run to `paused`. Upon resume with `skip-enter`, completed branches are not re-executed; only the paused branch resumes. If a run was `interrupted`, re-entering a branch node requires `resumeRerun: true`.

### Plan

Umbrella execution roster covering Feature C2:

| Sub-task | Covers | Surface | Title | Status |
|----------|--------|---------|-------|--------|
| TBD (Child 1) | R1 | schema/validation | Fork-join workflow definition schema, validation rules, and unhandled parallel rejection | backlog |
| TBD (Child 2) | R2 | infra/db | Durable branch execution ledger schema, persistence adapter methods, and atomic join commit | backlog |
| TBD (Child 3) | R3, R5 | code/engine | TransitionFlowDriver parallel region scheduler, concurrency bounding, and variable isolation | backlog |
| TBD (Child 4) | R4 | code/runtime | ActionRunContext AbortSignal propagation and fail-fast process-group cancellation | backlog |
| TBD (Child 5) | R6 | code/recovery | Per-branch pause, resume, and crash recovery with resumeRerun checks | backlog |
| TBD (Child 6) | R7 | code/tests | Branch observability events, tracing, and multi-channel publish E2E integration tests | backlog |

<!-- AUTO-GENERATED by spur task refresh-roster -->
| WBS | Sub-task | Status |
| --- | -------- | ------ |
| 0093 | Fork-join workflow definition schema, validation rules, and unhandled parallel rejection | done |
| 0094 | Durable branch execution ledger schema, persistence adapter methods, and atomic join commit | todo |
| 0095 | TransitionFlowDriver parallel region scheduler, concurrency bounding, and variable isolation | todo |
| 0096 | ActionRunContext AbortSignal propagation and fail-fast process-group cancellation | todo |
| 0097 | Per-branch pause, resume, and crash recovery with resumeRerun checks | todo |
| 0098 | Branch observability events, tracing, and multi-channel publish E2E integration tests | todo |
<!-- END AUTO-GENERATED -->

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- Field declared but unread: `src/types.ts:125` (`type?: 'action' | 'gate' | 'parallel' | 'decision'`),
  `src/schema.ts:139`, `schemas/transition-flow-workflow.schema.json`.
- Single-cursor execution: `src/state-machine.ts:88-220` (`while (true)` → `enter` → `runActionSequence` →
  `firstPassingTransition` → `commitHop`); per-run transition lock: `src/service.ts:26`.
- Consumer contract and the decision that defers this work: knowledge-kit `docs/00_ADR.md` ADR-007 R4 and its
  2026-10-03 amendment, ADR-019, `docs/03_ARCHITECTURE.md` §Execution substrate.
- Workaround evidence (why the deferral now costs): `plugins/kk/workflows/kk-daily-ai-voice.yaml:805-820`
  (WeChat edge chained behind the XHS path under first-match-wins); knowledge-kit `.spur/context/learnings.md`
  entry "Daily 20261002 publish-tail forensics (20261003)".
- Concurrency patterns to match: `apps/cli/src/fanin.ts:377-380`, `apps/cli/src/fanout.ts` (`fanout()`).

### History

- 2026-10-04T21:27:38.547Z backlog → todo (system)

