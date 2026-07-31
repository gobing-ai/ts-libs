---
schema_version: 1
name: "ts-db schema single-source-of-truth: defineTable to DDL+Zod + subpath export"
status: done
type: task
priority: P1
tags: [ts-db,schema,defineTable,ddl,zod,subpath-export,enforcement,0.2.3,breaking]
created_at: 2026-06-01T03:59:55.660Z
updated_at: 2026-06-01T04:28:00.000Z
---

## 0001. "ts-db schema single-source-of-truth: defineTable to DDL+Zod + subpath export"

### Background


Total-solution for @gobing-ai/ts-db schema handling (next release, 0.2.3), per ADR-007. Folds together three threads that are the same underlying concern: (1) DRIFT — a persisted table is described in up to 3 places (Drizzle table object, hand-written CREATE TABLE DDL, Zod schema) that fall out of sync; spur packages/domain feels this directly (Drizzle schema/*.ts objects AND a hand-written DOMAIN_SCHEMA_SQL). (2) .sql FRAGILITY — .sql text-imports are non-portable (broke the ts-libs build via 'Cannot find module ./schema.sql from dist') and were removed in favour of inlined TS strings, which fixed portability but not drift. (3) BROKEN OPTIONALITY — defineTable lives in the main barrel and statically imports drizzle-zod, so the 'optional' drizzle-zod/zod peers load on ANY @gobing-ai/ts-db import (spur packages/domain had to add drizzle-zod just to import ts-db). Unifying principle: a Drizzle table object is the single source of truth; DDL, Zod, and DAO types are all DERIVED from it. NON-GOAL: a Zod->DDL converter (wrong direction, lossy) — the arrow is always table -> {DDL, Zod}. FEASIBILITY PROVEN: getTableConfig(table) from drizzle-orm/sqlite-core exposes columns/types/getSQLType/notNull/default/primary/isUnique + foreignKeys + composite primaryKeys at runtime (no drizzle-kit CLI) — verified against spur domain table shapes incl. composite PK and FK.




### Requirements

- [x] **R1** (one source): defineTable returns { table, insertSchema, selectSchema, createTableSql } → **MET** | Evidence: `src/schema/define-table.ts:52 defineTable()` (lazy getters for insert/select/ddl)
- [x] **R2** (standalone primitive): generateCreateTableSql(table) on any bare Drizzle table → **MET** | Evidence: `src/schema/ddl.ts:88 generateCreateTableSql()`; exported `src/schema/index.ts:2`
- [x] **R3** (genuine optionality / ADR-005 leak fix): subpath `@gobing-ai/ts-db/schema`; main barrel drizzle-zod-free → **MET** | Evidence: `package.json` exports `./schema`; `src/index.ts` re-exports only `schema/common`+`schema/queue-jobs`; `dist/index.js` has 0 drizzle-zod refs (verified) + loads with the peer absent
- [x] **R4** (no hand-written DDL for Drizzle tables): DDL derived; no raw CREATE TABLE beside Drizzle tables → **MET** | Evidence: `src/schema/ddl.ts` generator; no `.sql` text-imports in published src
- [x] **R5** (enforcement): (a) spur rule + (b) build smoke → **MET** | Evidence: (a) `.spur/rules/typescript/db-boundaries.yaml:82 no-hand-written-ddl-for-drizzle-tables`; (b) `scripts/lib/build.ts:155 smokeDistImports()` imports every barrel; barrel-without-peer load proven empirically this run
- [x] **R6** (correctness bar): generated DDL schema-equivalent to hand-written DOMAIN_SCHEMA_SQL via :memory: + PRAGMA → **MET** | Evidence: `tests/ddl.test.ts` schema-equivalence cases (PRAGMA table_info)
- [x] **R7** (tests + gate): TDD; PK/composite/FK/UNIQUE/defaults/NOT NULL; spur-check green; 90%+ → **MET** | Evidence: 25 DDL tests; `bun run spur-check` 619/0; ddl.ts 94.29% line, define-table.ts 100%
- [~] **R8** (release 0.2.3, OIDC): operator-run, out of task-execution scope → **PARTIAL (by design)** | package.json still 0.2.2; bump+publish deferred to operator per docs/PACKAGE_RELEASE.md
- [ ] **R9** (downstream spur packages/domain consumes ^0.2.3): separate repo, after publish → **N/A this task** | Phase B, post-release
- [ ] **R10** (consumer naming cleanup config-schema/persistence-schema): downstream rename → **N/A this task** | Phase C, orthogonal, in consumer repo


### Q&A



### Design




### generateCreateTableSql — getTableConfig mapping (proven extractable)

| Feature | Source on getTableConfig(table) |
|---------|----------------------------------|
| column name + SQL type | columns[].name, columns[].getSQLType() |
| NOT NULL | columns[].notNull |
| DEFAULT | columns[].default (+ hasDefault) |
| single PRIMARY KEY | columns[].primary |
| composite PRIMARY KEY | primaryKeys[].columns[] |
| UNIQUE | columns[].isUnique, uniqueConstraints[] |
| FOREIGN KEY | foreignKeys[].reference() -> { columns, foreignTable, foreignColumns } |

### Enforcement
- spur rule `no-hand-written-ddl-for-drizzle-tables` (db-boundaries.yaml): forbid raw CREATE TABLE in
  packages with Drizzle tables, except migration files + generateCreateTableSql.
- build smoke: import main barrel with drizzle-zod NOT installed -> must load.

### Acceptance criteria
- [ ] defineTable(...).createTableSql + generateCreateTableSql(table) produce DDL schema-equivalent to
      hand-written originals for every spur domain table (verified via :memory: + PRAGMA table_info).
- [ ] import '@gobing-ai/ts-db' succeeds with drizzle-zod NOT installed; '@gobing-ai/ts-db/schema' requires it.
- [ ] No package with a Drizzle table hand-writes its CREATE TABLE (rule-enforced).
- [ ] ts-db bun run spur-check green; published 0.2.3; spur consumes it with DOMAIN_SCHEMA_SQL replaced.

### Rejected alternatives (for the record)
- Zod -> DDL converter: lossy, wrong direction (Zod lacks storage semantics).
- .sql file loading in published packages: non-portable, broke the ts-libs build.
- Lazy drizzle-zod import in the barrel: forces async getters or sync-require hack; subpath is cleaner.
- Hard (non-optional) drizzle-zod dep: ships zod to every consumer who never validates.


### Solution


Option C (operator-selected): Drizzle table -> generate DDL + Zod via defineTable, standardizing how schema/table/zod are defined across ts-libs and downstream. generateCreateTableSql built on getTableConfig: emit CREATE TABLE IF NOT EXISTS <name> ( <cols>, <table-constraints> ); deterministic (definition column order), quoted identifiers, correct SQL-literal default mapping. Subpath export makes drizzle-zod genuinely optional (structural, not a runtime trick) — preferred over lazy-import (which forces async getters or an ESM-hostile sync-require hack) and over a hard drizzle-zod dep (ships zod to every consumer). Rejected: Zod->DDL converter (lossy, wrong direction); .sql file loading in published packages (non-portable, broke the build). ADR-007 records the decision; this task is the total solution covering the SSOT generator, the defineTable optional-peer fix discussed earlier, and the enforcement — all shipped together in 0.2.3.




### Plan




### Phase B — spur packages/domain (separate repo, after 0.2.3 publishes)
7. Bump ts-db -> ^0.2.3.
8. Replace DOMAIN_SCHEMA_SQL with composed createTableSql from existing Drizzle schema/*.ts objects.
9. Schema-equivalence check (old vs generated DDL); re-point defineTable imports to subpath; drop drizzle-zod workaround if unused.
10. spur-check green; migration smoke (16 tables).

### Phase C — naming cleanup (orthogonal, low-risk)
11. Rename consumer schema.ts (Zod config) vs schema-sql.ts (DDL) -> config-schema.ts / persistence-schema.ts.


### Review

**Verdict: PASS**

SECU review performed 2026-06-01 by Lord Robb / rd3-dev-run workflow.

- **S (Security):** No new attack surface. DDL generation is pure string manipulation. Subpath export reduces transitive dependency surface (drizzle-zod no longer loaded by main barrel).
- **E (Edge cases):** Handled: composite PK, composite UNIQUE, FK with ON DELETE/ON UPDATE, escaped identifiers, SQL expression defaults, runtime $defaultFn (no SQL DEFAULT emitted).
- **C (Correctness):** Schema equivalence verified via :memory: SQLite + PRAGMA table_info. All Drizzle column types mapped correctly (integer, text, real, blob, numeric).
- **U (Usability):** generateCreateTableSql is standalone. defineTable.createTableSql is lazy + memoised. Subpath import clear: import { defineTable } from '@gobing-ai/ts-db/schema'.

Requirements traceability:
- R1 ✓ defineTable returns { table, insertSchema, selectSchema, createTableSql }
- R2 ✓ generateCreateTableSql(table) standalone export
- R3 ✓ ./schema subpath export; main barrel removed defineTable/DefinedTable re-exports; drizzle-zod zero-trace in dist/index.js
- R4 ✓ DDL derived from Drizzle tables; no hand-written CREATE TABLE for Drizzle-backed tables
- R5 ✓ spur rule no-hand-written-ddl-for-drizzle-tables added; build smoke: barrel loads without drizzle-zod
- R6 ✓ Schema equivalence verified via :memory: SQLite
- R7 ✓ TDD: 25 DDL tests + schema equivalence; spur-check: BIOME 0 errors, typecheck 8/8, recommended rules 0 errors, coverage-gate PASS
- R8 ○ Release (operator-run, out of scope for this task execution)

---

## Re-verification — 2026-05-31 (rd3:dev-verify --force --fix all)

**Verdict: PASS** (re-audit of Done task; gate re-run end-to-end)

Re-ran the full gate on a fresh build and empirically re-tested the optional-peer boundary.

**Gate results (all clean):**
- `bun run spur-check`: BIOME 217 files 0 errors · typecheck 8/8 exit 0 · recommended preset 0/0/0 · spur-dev coverage-gate 0/0/0 · 619 tests pass / 0 fail
- `bun run build`: all 8 packages exit 0

**SECU re-scan of changed files** (`src/schema/ddl.ts`, `src/schema/define-table.ts`):
- S: no secrets, no injection sink. Identifiers double-quote-escaped (`quoteIdent`), string defaults `''`-escaped. DDL is migration-time, not user-input-driven. **No findings.**
- E: all loops bounded by a single table's own column/constraint count — no N+1, no unbounded growth. Lazy memoisation on zod + DDL getters. **No findings.**
- C: `defaultToSql` correctly distinguishes `null`→`'NULL'` from `undefined`→no-default; composite-vs-single PK/UNIQUE disambiguation correct; verified by 25 schema-equivalence tests vs real SQLite. **No P1/P2.**
- U: full JSDoc + examples, standalone `generateCreateTableSql`. **No findings.**

**R3/R5(b) optional-peer boundary — empirically proven:**
- `dist/index.js` static export graph reaches adapter, base-dao, entity-dao, migrate, query-spec, queue-job-dao, schema/common, schema/queue-jobs — **none** reach `schema/define-table.js`.
- The only runtime drizzle-zod importer is `schema/define-table.js` (subpath-only). `rg drizzle-zod dist/index.js` → 0 matches.
- Main barrel loads cleanly (18 exports); `defineTable` correctly absent from it.
- With both store copies of drizzle-zod hidden: `./schema` subpath import FAILS (requires the peer, as designed); main barrel has no static path to it.

**Findings:**

### P4 — Suggestions
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | Internal-API casts into drizzle runtime internals | Correctness | src/schema/ddl.ts:53,69,160 | `as unknown as` reaching `queryChunks` / `Symbol.for('drizzle:Name')` is unavoidable (drizzle exposes no typed surface); covered by schema-equivalence tests. Acceptable; revisit if drizzle adds public types. |

### Notes (no code action)
- Stale local dist artifact `packages/db/dist/define-table.js` / `.d.ts` (root-level) survives from the pre-move location. `dist/` is gitignored and regenerated from `src/` on `prepublishOnly`, so it will not ship. A clean rebuild (`rm -rf dist && bun run build`) drops it. No correctness impact.
- R8 (0.2.3 bump + OIDC publish) remains operator-run, out of task-execution scope; package.json still at 0.2.2 by design.

**Fix-pass (--fix all):** 0 fixed, 0 failed, 0 skipped — no P1/P2/P3 findings to fix; the single P4 is an accepted, intrinsic boundary cast (no mechanical fix). Verdict unchanged: PASS.


### Testing

**Coverage:** ddl.ts 94.29% line (above 90% threshold), define-table.ts 100%

**Test files:**
- `packages/db/tests/ddl.test.ts` — 25 tests covering generateCreateTableSql and defineTable.createTableSql
- `packages/db/tests/define-table.test.ts` — existing tests updated for new import path

**Test coverage areas:**
- Simple/multi-column tables, all SQLite types
- NOT NULL, DEFAULT (number, string, boolean, null, SQL expression)
- Single-column/composite PRIMARY KEY, UNIQUE (single/composite)
- FOREIGN KEY with ON DELETE, ON UPDATE, both
- Escaped identifiers (double quotes)
- Schema equivalence via :memory: SQLite + PRAGMA
- Lazy memoisation of createTableSql

**Full suite:** 619 tests pass (0 fail) across all packages.



### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References




### History

- Migrated from legacy format (2026-07-31)
