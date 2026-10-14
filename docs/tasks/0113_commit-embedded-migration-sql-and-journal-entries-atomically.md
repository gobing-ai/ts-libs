---
schema_version: 1
name: Commit embedded migration SQL and journal entries atomically
status: todo
template: feature-impl
created_at: 2026-10-14T03:37:05.705Z
updated_at: "2026-10-14T03:51:29.351Z"
feature_id: B

priority: P2
ac_numbering: task-local
ac_altitude: task-local
estimate_hours: 2
---

## 0113. Commit embedded migration SQL and journal entries atomically

### Background

Review reproduced a restart failure in the embedded migration fallback. `packages/db/src/migrate.ts:97` executes each migration statement separately, then line 102 writes the journal outside a transaction. Injecting one journal INSERT failure for migration 0005_queue_attempt_ownership caused the first applyMigrations call to fail with `injected journal failure`; retry failed with `duplicate column name: timeout_ms`. Schema changes survived while the hash did not. `packages/db/src/adapters/bun-sqlite.ts:112` already provides transactional batch operations. Feature B owns migrations; applyMigrations admits only BunSqliteAdapter. This review separately fixed inherited decision inputs and fixture test inventory; those do not resolve migration atomicity.

**Refine corrections (2026-10-13)**

- Trigger injection was an example without a complete setup → a real TEMP trigger on a precreated journal reproduced the failure and left five earlier journal rows committed → freeze trigger creation/removal, forced embedded selection and PRAGMA assertions, including a custom journal name.
- R1 requires rollback on any statement failure but AC covered only journal insertion → add a mid-SQL failure scenario forwarded into the real batch, without changing bundled migrations.
- Environment was assumed locked → actual parent drizzle-orm 0.44.7 differs from bun.lock 0.38.4 → add locked-install and package-local resolution verification as Step 0.

### Requirements

- [ ] R1. Each embedded migration commits all its SQL statements and journal insertion together, or rolls all of them back on failure.
- [ ] R2. A failed embedded migration can be retried successfully without duplicate-column errors; earlier committed migrations remain recorded and are skipped.
- [ ] R3. Existing custom journal names, validation, logging and successful rerun behavior remain compatible without new public APIs or dependencies.

### Acceptance Criteria

```gherkin
Scenario: AC1 — Journal failure rolls back schema changes (req: R1)
  Given embedded migration 0005 with an injected failure at its journal insertion
  When applyMigrations rejects
  Then none of that migration's added columns or its journal entry exist

Scenario: AC2 — Retry completes after a transient failure (req: R2)
  Given the same adapter after the transient journal failure is removed
  When applyMigrations runs twice
  Then both calls succeed and each migration hash has exactly one journal row
  And previously committed migration rows are unchanged

Scenario: AC3 — Existing migration contracts remain supported (req: R3)
  Given default and custom legal journal names and an invalid name
  When existing migration tests run
  Then legal names work, invalid names fail before migration writes, and logging remains intact

Scenario: AC4 — Mid-migration SQL failure rolls back the whole migration (req: R1)
  Given a failing SQL operation inserted into the real batch after the first 0005 ALTER
  When applyMigrations rejects
  Then none of the 0005 columns or its journal hash exist
  And previously committed migration rows remain unchanged
```

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-10-14T03:38:05.257Z

Closed: reuse adapter.batch with per-migration atomicity. Repair of databases already left inconsistent is explicitly outside scope.

#### Q&A entry — 2026-10-14T03:51:29.083Z

Closed in ready refinement: reuse one real adapter.batch per migration; test journal and mid-SQL rollback without modifying bundled migrations. Precreate the journal for a TEMP failure trigger. Locked dependency restoration precedes implementation; existing inconsistent databases remain out of scope.

### Design

No new API. Targets: packages/db/src/migrate.ts and packages/db/tests/migrate.test.ts. In applyEmbeddedMigrations replace statement-by-statement exec and separate journal run with one adapter.batch per migration: ordered SQL operations with empty params followed by the existing parameterized journal INSERT with migration.hash and Date.now(). DbBatchOp from packages/db/src/adapter.ts carries sql:string and readonly params; BunSqliteAdapter.batch at packages/db/src/adapters/bun-sqlite.ts:112 executes these synchronously inside the existing SQLite transaction. Reuse that seam; do not add another transaction layer or modify the adapter. Keep journal-name validation, statement splitting, logging and applied counting, with counting only after successful batch completion. Update the affected internal method comment to describe the batch. Atomicity is per migration; earlier migrations stay committed after a later failure. Journal table creation remains outside the per-migration transaction.

Regression setup in packages/db/tests/migrate.test.ts: use a real in-memory BunSqliteAdapter; create the journal using the current id/hash/created_at schema before calling applyMigrations. Find the 0005_queue_attempt_ownership hash from embeddedMigrations; install a TEMP trigger BEFORE INSERT ON the journal, WHEN NEW.hash equals that hash, executing SELECT RAISE(ABORT, 'injected journal failure'). Force the embedded path with an injected fs.exists returning false (following the existing fs test seam). Do not mock batch or throw before it begins. After rejection use PRAGMA table_info(queue_jobs) to assert all four 0005 columns are absent and query the journal to assert its hash is absent while earlier rows remain. Drop the trigger, rerun, rerun again and compare journal rows/hashes to prove successful retry and idempotence. Keep adapters closed in finally. Repeat the failure/retry setup for a legal custom journal name to observe correct INSERT routing.

Also cover a failure in the middle of migration SQL: for the test only, wrap adapter.batch and forward its real operation list with a deliberately failing statement inserted after the first 0005 ALTER and before the remaining operations/journal. Restore the wrapper in finally. This exercises the real transaction, unlike replacing batch with a stub rejection. Assert rollback with PRAGMA and absence of its journal hash. Do not mutate embeddedMigrations, hashes or checked-in SQL fixtures to inject failures.

Rejected alternatives: wrapping awaited adapter calls in a synchronous transaction; making ALTER statements silently idempotent; changing hashes or rebuilding existing databases. Out of scope: file-based migrator, SQL parser changes, automatic repair of already-inconsistent journals, D1 migrations, cross-process migration locking.

Precondition: restore locked dependencies with bun install --frozen-lockfile and verify drizzle-orm resolution from packages/db/src against bun.lock. Audit observed a 0.44.7 parent-directory fallback although bun.lock pins 0.38.4; Bun is 1.4.3. Do not upgrade manifests/lockfile to fit the fallback; resolve installation before implementation. No unfinished dependencies; 0112 is independent. Workspace audit found only main and no wip tasks. Preserve unrelated working-tree edits. ADR-020 establishes the existing batch seam; the migration fix requires no architecture decision change.

### Plan

- [ ] Step 0: restore locked dependencies with bun install --frozen-lockfile; verify Bun 1.4.3 and drizzle-orm resolution from packages/db/src matches bun.lock, with no manifest or lockfile changes.
- [ ] Add the real-SQLite journal-trigger regression for 0005, forcing embedded migration via fs.exists=false; assert all four columns and its hash are absent after rejection while prior journal rows remain (R1).
- [ ] Build one DbBatchOp list per embedded migration, ending with its journal INSERT, call adapter.batch and update the local comment; retain existing validation/logging (R1, R3).
- [ ] Drop the failure trigger, retry twice and assert unique migration hashes and unchanged prior rows; cover a legal custom journal name, invalid name, and mid-SQL failure through the real batch (R1-R3).
- [ ] Run bun test packages/db/tests/migrate.test.ts, bun run spur-check and bun run build; record final results against R1-R3.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- Readiness probes: `.spur/run/refineall-0112-0113-probes.ts`; executed this refinement, using disposable in-memory databases and injected queue I/O.
- Current work: only /Users/robin/xprojects/ts-libs on main; spur task list --status wip --json returned []; no declared dependencies and no dependency between 0112 and 0113.
- Runtime: Bun 1.4.3; TypeScript 6.0.3 and @types/bun 1.4.3 match bun.lock; Drizzle resolution mismatch is an explicit Step 0 precondition.
- Original review: `.spur/run/review-packages-scripts-2026-10-13.md`.
- Feature B: docs/features/B_ts-db.md; ADR-020 in docs/00_ADR.md. Transaction seam: `packages/db/src/adapters/bun-sqlite.ts:112`; migration/journal split: `packages/db/src/migrate.ts:97`.

### History

- 2026-10-14T03:38:14.383Z backlog → todo (system)

