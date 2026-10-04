---
schema_version: 1
name: Durable branch execution ledger schema, persistence adapter methods, and atomic join commit
status: todo
template: feature-impl
created_at: 2026-10-04T21:10:02.276Z
updated_at: "2026-10-04T21:28:12.941Z"
feature_id: C2
parent_wbs: "0092"
priority: P2
tags:
  - dual-workflow-engine
  - fork-join
  - persistence
estimate_hours: 6

dependencies: ["0093"]
---

## 0094. Durable branch execution ledger schema, persistence adapter methods, and atomic join commit

### Background

Implements: R6 — Persisted branch execution ledger and idempotent join activation.

Today, `WorkflowPersistenceAdapter` tracks a single current state per run (`workflow_states` and `phase_runs`). For concurrent branch execution, recording single-cursor hops causes state overwrites and makes restart recovery ambiguous.

This task extends the persistence schema and adapter interface to support a durable branch execution ledger in both SQLite/D1 (`DbWorkflowPersistenceAdapter`) and in-memory (`MemoryWorkflowPersistenceAdapter`). It ensures branch start, progress, completion, and atomic join activation are durably recorded with ownership fencing.

### Requirements

- [ ] R1. WORKFLOW_ENGINE_SCHEMA_SQL and migrations define the branch execution ledger table (workflow_branches) with run_id, parallel_node, branch_id, status, node, output_vars_json, and error.
- [ ] R2. WorkflowPersistenceAdapter exposes saveBranchStart, saveBranchFinalize, and listRunBranches with identical contracts in Db and Memory adapters.
- [ ] R3. Atomic batch commitJoin records all branch outcomes and transitions the parent run to the join node in a single transaction (ADR-020).
- [ ] R4. Out of scope: In-memory branch scheduling and thread management (owned by task 0095).

### Acceptance Criteria

- [ ] AC1 — Persisted branch execution ledger and idempotent join activation (req: R1; req: R2; req: R3)

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

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- Feature: C2 (Durable structured fork-join parallel execution)
- Umbrella Task: 0092 (Implement fork/join parallel node execution)
- ADR-020 (Atomic Workflow Transition Persistence)
- Dependency: 0093 (Schema and types)

### History
