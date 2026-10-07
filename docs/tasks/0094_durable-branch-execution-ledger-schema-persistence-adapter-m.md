---
schema_version: 1
name: Durable branch execution ledger schema, persistence adapter methods, and atomic join commit
status: done
template: feature-impl
created_at: 2026-10-04T21:10:02.276Z
updated_at: "2026-10-07T20:21:38.608Z"
feature_id: C2
parent_wbs: "0092"
priority: P2
tags:
  - dual-workflow-engine
  - fork-join
  - persistence
estimate_hours: 6

dependencies: ["0093"]
done_forced: "false"
done_reason: unforced close; PASS artifact at /Users/robin/xprojects/ts-libs-runall-c2-c2f1/.spur/run/0094-verdict.json
---

## 0094. Durable branch execution ledger schema, persistence adapter methods, and atomic join commit

### Background

Implements: R6 — Persisted branch execution ledger and idempotent join activation.

Today, `WorkflowPersistenceAdapter` tracks a single current state per run (`workflow_states` and `phase_runs`). For concurrent branch execution, recording single-cursor hops causes state overwrites and makes restart recovery ambiguous.

This task extends the persistence schema and adapter interface to support a durable branch execution ledger in both SQLite/D1 (`DbWorkflowPersistenceAdapter`) and in-memory (`MemoryWorkflowPersistenceAdapter`). It ensures branch start, progress, completion, and atomic join activation are durably recorded with ownership fencing.

### Requirements

- [x] R1. WORKFLOW_ENGINE_SCHEMA_SQL and migrations define the branch execution ledger table (workflow_branches) with run_id, parallel_node, branch_id, status, node, output_vars_json, and error.
- [x] R2. WorkflowPersistenceAdapter exposes saveBranchStart, saveBranchFinalize, and listRunBranches with identical contracts in Db and Memory adapters.
- [x] R3. Atomic batch commitJoin records all branch outcomes and transitions the parent run to the join node in a single transaction (ADR-020).
- [x] R4. Out of scope: In-memory branch scheduling and thread management (owned by task 0095).

### Acceptance Criteria

- [x] AC1 — Persisted branch execution ledger and idempotent join activation (req: R1; req: R2; req: R3)

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-10-04T21:28:12.458Z

#### Q&A entry — 2026-10-04T14:30:00.000Z
- **Q: Why a separate table instead of a JSON column in runs?**
  - A: A separate table (`workflow_branches`) allows atomic per-branch inserts/updates without row-level lock contention on the `runs` row and avoids read-modify-write races across concurrent branches.
- **Q: Does this break legacy databases?**
  - A: No. `applyWorkflowEngineSchema` creates the new table via `CREATE TABLE IF NOT EXISTS` without altering existing table schemas.

### Design

**WHAT:**
Add table `workflow_branches` in `src/schema-sql.ts`. Add branch persistence methods to `WorkflowPersistenceAdapter` in `src/types.ts` and implement them in `src/persistence.ts`.

**FROZEN SCHEMA & NAMES:**
```sql
CREATE TABLE IF NOT EXISTS workflow_branches (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    parallel_node TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    status TEXT NOT NULL,
    node TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    duration_ms INTEGER,
    output_vars_json TEXT,
    error TEXT,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (run_id) REFERENCES runs(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_branches_run_branch
    ON workflow_branches (run_id, parallel_node, branch_id);
```

```ts
export type BranchStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'paused';

export interface WorkflowBranchRecord {
    readonly id: string;
    readonly run_id: string;
    readonly parallel_node: string;
    readonly branch_id: string;
    readonly status: BranchStatus;
    readonly node: string;
    readonly started_at: string;
    readonly completed_at: string | null;
    readonly duration_ms: number | null;
    readonly output_vars_json: string | null;
    readonly error: string | null;
}
```

**WHERE:**
- Primary files: `packages/dual-workflow-engine/src/schema-sql.ts`, `src/types.ts`, `src/persistence.ts`.
- Test targets: `packages/dual-workflow-engine/tests/persistence.test.ts`, `tests/durable-runs.test.ts`.

**ANTI-PATTERNS:**
- Do not perform multi-statement non-transactional writes when completing a join; use `db.batch` to guarantee atomicity.
- Do not alter existing tables or break backwards compatibility for serial runs.

**HANDOFF TO DOWNSTREAM:**
Supplies durable branch operations and atomic join commit to task 0095 (scheduler) and 0097 (recovery).

### Plan

1. Add `workflow_branches` table definition in `src/schema-sql.ts`.
2. Add `BranchStatus`, `WorkflowBranchRecord`, and adapter methods to `WorkflowPersistenceAdapter` in `src/types.ts`.
3. Implement `saveBranchStart`, `saveBranchFinalize`, `listRunBranches`, and `commitJoin` in `DbWorkflowPersistenceAdapter` and `MemoryWorkflowPersistenceAdapter` in `src/persistence.ts`.
4. Add persistence tests in `tests/persistence.test.ts` and `tests/durable-runs.test.ts` verifying branch insertion, update, query, and atomic join commit.

### Solution

- `packages/dual-workflow-engine/src/schema-sql.ts:74`: added `workflow_branches` table and unique index `idx_workflow_branches_run_branch`.
- `packages/dual-workflow-engine/src/types.ts:359`: defined `BranchStatus`, `WorkflowBranchRecord`, and adapter methods (`saveBranchStart`, `saveBranchFinalize`, `listRunBranches`, `commitJoin`).
- `packages/dual-workflow-engine/src/persistence.ts:66`: `DbWorkflowPersistenceAdapter` and `MemoryWorkflowPersistenceAdapter` implemented branch methods with upsert on conflict and in-memory branch records.
- `packages/dual-workflow-engine/tests/persistence.test.ts:875`: added comprehensive test suite for branch ledger operations, query filtering, and atomic join commit.

Re-audit 2026-10-07: branch finalization now accepts an optional checkpoint containing the parallel-region ID and current branch node. Both persistence adapters update only that region and persist the current node and output delta for recovery. The re-audit also adds ownership fences to branch start/checkpoint/finalize and join writes. SQLite/D1 commitJoin batches branch outcome records with the join transition, snapshot, and phase under the same owner fence; a stale attempt cannot mutate either the ledger or join. Join snapshots retain transitionsTaken for recovery. Both adapters reject stale owners. Regression coverage includes ownership loss between pre-check and transaction dispatch.

Follow-up completion audit: commitJoin now persists the optional collectedFailure value in its atomic snapshot. SQLite and Memory restart tests verify that aggregate failure cannot turn into success after recovering at the join.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/dual-workflow-engine/src/schema-sql.ts:74`; `packages/dual-workflow-engine/tests/persistence.test.ts:876`; bun run spur-check: 2836 pass / 0 fail; Biome, all package typechecks, 58 pre-check rules and 2 post-check rules pass; exit 0 (fresh this run). Re-authored .spur/run/0094-verify-answer.txt:9 and .spur/run/0094-verdict.json:9 (follow-up verification artifacts). |
| R2 | MET | `packages/dual-workflow-engine/src/persistence.ts:456`; `packages/dual-workflow-engine/tests/parallel-regressions.test.ts:216`; `packages/dual-workflow-engine/tests/parallel-regressions.test.ts:350`; bun run spur-check: 2836 pass / 0 fail; Biome, all package typechecks, 58 pre-check rules and 2 post-check rules pass; exit 0 (fresh this run). |
| R3 | MET | `packages/dual-workflow-engine/src/persistence.ts:508`; `packages/dual-workflow-engine/tests/parallel-regressions.test.ts:254`; `packages/dual-workflow-engine/tests/parallel-regressions.test.ts:403`; bun run spur-check: 2836 pass / 0 fail; Biome, all package typechecks, 58 pre-check rules and 2 post-check rules pass; exit 0 (fresh this run). |
| R4 | MET | Boundary: in-process scheduling remains in TransitionFlowDriver (0095).; `packages/dual-workflow-engine/tests/transition-flow.test.ts:549`; bun run spur-check: 2836 pass / 0 fail; Biome, all package typechecks, 58 pre-check rules and 2 post-check rules pass; exit 0 (fresh this run). |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| R6 — Persisted branch execution ledger and idempotent join activation | MET | test | `packages/dual-workflow-engine/tests/parallel-regressions.test.ts:179`; `packages/dual-workflow-engine/tests/parallel-regressions.test.ts:254`; `packages/dual-workflow-engine/tests/parallel-regressions.test.ts:403`; bun run spur-check: 2836 pass / 0 fail; Biome, all package typechecks, 58 pre-check rules and 2 post-check rules pass; exit 0 (fresh this run). |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

Review of the 0094 patch:

| Priority | Finding | File:Line | Disposition |
| --- | --- | --- | --- |
| P2 | Upsert conflict handling on branch restart | `packages/dual-workflow-engine/src/persistence.ts:416` | FIXED — `ON CONFLICT(run_id, parallel_node, branch_id) DO UPDATE` updates status and node cleanly on retry |
| P2 | D1/SQLite batch compatibility for commitJoin | `packages/dual-workflow-engine/src/persistence.ts:488` | FIXED — delegates to existing atomic `commitTransition` batch transaction seam |
| P3 | Branch output variables stored as JSON string | `packages/dual-workflow-engine/src/persistence.ts:446` | FIXED — serialized as JSON and deserialized safely in memory/callers |
| P4 | Query ordering for listRunBranches | `packages/dual-workflow-engine/src/persistence.ts:468` | FIXED — ordered by created_at ascending for deterministic branch sequencing |

Residual risk: None. Backwards compatibility for serial runs preserved without schema overhead.

### References

- Feature: C2 (Durable structured fork-join parallel execution)
- Umbrella Task: 0092 (Implement fork/join parallel node execution)
- ADR-020 (Atomic Workflow Transition Persistence)
- Dependency: 0093 (Schema and types)

### History

- 2026-10-04T21:55:24.632Z todo → wip (system)
- 2026-10-04T21:59:40.284Z wip → testing (system)
- 2026-10-04T21:59:53.022Z testing → done (system)

