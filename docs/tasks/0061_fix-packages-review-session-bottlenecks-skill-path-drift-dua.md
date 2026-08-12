---
template: meta
schema_version: 1
name: "Fix packages-review session bottlenecks: skill path drift, dual-pass waste, L3 first-write"
description: ""
status: done
type: meta
profile: standard
feature_id: null
parent_wbs: null
priority: P2
tags: ["meta"]
dependencies: ["0060"]
ac_numbering: task-local
created_at: "2026-08-12T18:41:45.051Z"
updated_at: "2026-08-12T21:21:39.707Z"
---

## 0061. Fix packages-review session bottlenecks: skill path drift, dual-pass waste, L3 first-write

### Background
Follow-up from **0060** (done 2026-08-12). 0060 shipped every MUST/SHOULD finding (R1–R15, R18). It **deferred** two MAY items and left the WBS blank:

- **R16** — importer ETL table/DDL locality (0030 architecture candidate A1)
- **R17** — `getGitContext` still defaults to deprecated `BunSyncProcessExecutor` (0030 candidate / ADR-023 A2 leftover)

This WBS **is** that follow-up. It is **not** a session-forensics / skill-path / hook task. Any earlier 0061 text about Grok `updates.jsonl`, `~/.agents/` skill links, or `--fix` deprecation is vacated. If those harness items are still wanted, they are a different task and must be authored against `/Users/robin/xprojects/spur-new` (not `~/.agents/`).

**Current code (re-read 2026-08-12, post-0060):**

R16. `HISTORY_IMPORT_SCHEMA_SQL` (`packages/llm-jsonl-importer/src/schema-sql.ts:21-82`) still hard-codes `CREATE TABLE history_etl_{pi,claude,codex,gemini,opencode,antigravity,openclaw}`. `LlmJsonlSource` also includes `omp`, `grok`, and `agy` (`types.ts:6-16`); those three only appear via `ensureTargetTables` + `ETL_TABLE_DDL` (`jsonl-importer-dao.ts:73-114`). Adding a built-in source requires editing the static SQL *and* `SOURCE_DEFINITIONS` or the new source silently depends on first-import DDL. Typed contract tables (`history_message`, `history_tool_call`) stay in the static SQL — they are not ETL blob tables.

R17. `getGitContext` (`packages/ai-runner/src/identity.ts:68-71`) is still sync and defaults to `new BunSyncProcessExecutor()`. In-tree callers: `packages/ai-runner/tests/identity.test.ts` and the README example (`packages/ai-runner/README.md:285-290`). No production orchestrator path calls it. ADR-023 A2 already published `ProcessExecutor` as the canonical type.

**Out of scope:** new importer sources, full 5-field cron, changing `VALID_TABLE_NAME`, removing `BunSyncProcessExecutor` from `@gobing-ai/ts-runtime`, editing `~/.agents/` or `~/.grok/`, `.github/workflows/`.
### Requirements
R1. `HISTORY_IMPORT_SCHEMA_SQL` no longer contains any `CREATE TABLE history_etl_*` statement. It keeps checkpoint, ledger, typed contract tables (`history_message`, `history_tool_call`), and their indexes.

R2. Every built-in `history_etl_*` table is created only through `ETL_TABLE_DDL` after `targetTableFor`. `applyHistoryImportSchema` must still create **all** built-in ETL tables (loop `SOURCE_DEFINITIONS` / `ensureTargetTables`) so callers who run the static schema and then insert without a prior `runJsonlImport` do not see `no such table`. Adding a new `LlmJsonlSource` + `SOURCE_DEFINITIONS` entry must create its ETL table with no further edit to `schema-sql.ts`.

R3. Importing each built-in source that uses an ETL blob table (`opencode`, `antigravity`, `openclaw`, `omp`, `grok`, `agy`, and the custom-split sources that still land on `history_etl_*` when not typed) succeeds on a fresh database after `applyHistoryImportSchema`. `VALID_TABLE_NAME` and typed-table skip in `ensureTargetTables` stay as they are.

R4. `getGitContext(workspacePath, executor?: ProcessExecutor)` is async and returns `Promise<string | null>`. The default executor is `nodeBunFactory.createProcessExecutor()` (or an equivalent `ProcessExecutor` from the runtime factory), **not** `new BunSyncProcessExecutor()`. It uses `executor.run` (same argv as today: `git -C <workspace> branch --show-current` then `status --porcelain`). Null semantics unchanged (non-zero exit or empty branch → `null`).

R5. A deprecated sync escape hatch remains for one release: `getGitContextSync(workspacePath, executor?: SyncProcessExecutor)` with the current sync body. In-tree production code and the README example use the async function. Tests cover both the async default path (fake `ProcessExecutor.run`) and the deprecated sync helper.

R6. Docs and changelog: importer README / `HISTORY_IMPORT_SCHEMA_SQL` comment match R1–R2. ai-runner README shows `await getGitContext(...)`. `CHANGELOG.md` records R4 as a **breaking** change (`getGitContext` is now async) and R1–R2 as a fix. A dated ADR-023 addendum states A2 leftover `getGitContext` is closed by this task. No new ADR number.

R7. `bun run spur-check` and `bun run build` exit 0. No skipped tests, no `biome-ignore` added to silence the gate. Internal deps stay `workspace:*`. No new runtime, linter, or formatter.
### Acceptance Criteria
```gherkin
Feature: 0060 deferred R16/R17 are implemented

  Scenario: R1 — static schema has no history_etl_* CREATE
    Given packages/llm-jsonl-importer/src/schema-sql.ts
    When HISTORY_IMPORT_SCHEMA_SQL is inspected
    Then it contains history_import_checkpoint, history_import_ledger, history_message, history_tool_call
    And it does not contain CREATE TABLE IF NOT EXISTS history_etl_

  Scenario: R2 — applyHistoryImportSchema still materializes every built-in ETL table
    Given a fresh sqlite adapter
    When applyHistoryImportSchema(db) runs
    Then SELECT from history_etl_pi, history_etl_grok, history_etl_omp, and history_etl_agy succeeds (empty)
    And those CREATE statements came from ETL_TABLE_DDL / ensureTargetTables, not from the static string
    And adding a new key to SOURCE_DEFINITIONS is enough for the next applyHistoryImportSchema to create its table

  Scenario: R3 — built-in ETL sources still import on a fresh DB
    Given applyHistoryImportSchema has been applied and no extra DDL
    When runJsonlImport is invoked for a source whose targetTable is history_etl_<source>
    Then the import does not fail with no such table
    And typed tables history_message / history_tool_call still come from the static schema

  Scenario: R4 — getGitContext is async ProcessExecutor
    Given packages/ai-runner/src/identity.ts
    When getGitContext is called with a fake ProcessExecutor whose run() returns exit 0 and stdout "main"
    Then the function returns a Promise that resolves to a Git context block containing branch: main
    And the default (no executor argument) does not construct BunSyncProcessExecutor
    When git returns non-zero
    Then the Promise resolves to null

  Scenario: R5 — deprecated sync helper remains
    Given getGitContextSync
    When it is called with a fake SyncProcessExecutor that fails
    Then it returns null synchronously
    And it is marked @deprecated
    And the README example uses await getGitContext

  Scenario: R6 — docs and ADR
    Given the change lands
    Then CHANGELOG has a BREAKING CHANGE note for async getGitContext
    And docs/00_ADR.md ADR-023 has a dated addendum that this task closes the A2 getGitContext leftover
    And the importer README no longer claims the static SQL string creates every history_etl_* table

  Scenario: R7 — gates
    Given the working tree after implementation
    When bun run spur-check and bun run build run
    Then both exit 0
    And no test is skipped to go green
```
### Q&A
**Q: Why is this the same WBS as the session-bottleneck write-up?**
A: 0060 deferred R16/R17 with “WBS to assign”. The operator designated 0061 as that follow-up. The previous 0061 body (Grok session forensics, `~/.agents/` skill paths) was the wrong subject and is vacated. Harness work belongs in `spur-new`, not this repo’s package task.

**Q: Why both R16 and R17 in one task?**
A: 0060 grouped them as the MAY leftover pair. They do not share code. If the implementer must split, spawn a child and `spur task deps` — do not silently drop one.

**Q: Is R16 a breaking schema change?**
A: No. `CREATE TABLE IF NOT EXISTS` via `ETL_TABLE_DDL` after `applyHistoryImportSchema` preserves the “schema applied ⇒ built-in ETL tables exist” contract and adds the three sources the static string omitted.

**Q: Is R17 breaking?**
A: Yes. `getGitContext` becomes async. In-tree cost is tests + README. Keep `getGitContextSync` deprecated for out-of-repo sync callers.

**Q: Why not delete BunSyncProcessExecutor?**
A: It is still a published (deprecated) ts-runtime export. This task only stops *this* package from default-constructing it.

**Q: Feature id?**
A: Two packages (E importer, A ai-runner). Leave `feature_id` unset; depend on 0060 instead.
### Design
**Chosen approach:** two surgical package changes. No new packages. No skill edits. Do not touch `~/.agents/`.

#### R16 — single owner for `history_etl_*` DDL

**Problem.** `schema-sql.ts:21-82` lists seven ETL tables. `SOURCE_DEFINITIONS` has ten sources (`types.ts:6-16`). `omp` / `grok` / `agy` are already first-class and only exist because `ensureTargetTables` (`jsonl-importer-dao.ts:105-114`) runs `ETL_TABLE_DDL` (`:73-81`) at import time. `applyHistoryImportSchema` (`:85-91`) still execs the stale static string. Two owners will drift again the next time a source is added.

**Fix.**

1. Delete every `CREATE TABLE IF NOT EXISTS history_etl_*` block from `HISTORY_IMPORT_SCHEMA_SQL`. Leave checkpoint, ledger, `history_message`, `history_tool_call`, and the four indexes.
2. After the static exec loop in `applyHistoryImportSchema`, iterate `Object.values(SOURCE_DEFINITIONS)` and `await ensureTargetTables(db, definition)`. That keeps “run schema SQL once, all built-in tables exist” for migration callers.
3. Export `ensureTargetTables` stays as-is (already exported). Do not invent a third DDL helper; `ETL_TABLE_DDL` remains the only CREATE text for blob ETL tables.
4. Update the module comment on `schema-sql.ts:1` and the WHY comment on `ensureTargetTables` (`jsonl-importer-dao.ts:96-103`) so they no longer say the static SQL creates built-in `history_etl_*` tables.
5. Tests:
   - `schema-sql.test.ts`: assert `HISTORY_IMPORT_SCHEMA_SQL` does **not** match `/history_etl_/`.
   - New `applyHistoryImportSchema` test: fresh adapter → apply → `SELECT COUNT(*) FROM history_etl_grok` / `history_etl_omp` / `history_etl_agy` / `history_etl_pi` does not throw.
   - Existing importer / forensic tests stay green.

**Rejected.** “Create ETL tables only on first import” — breaks anyone who `applyHistoryImportSchema` then raw-inserts. “Add the three missing CREATE blocks to the static string” — papers over the split; the next source will miss again.

**Compatibility.** Existing databases already have the seven static tables (`IF NOT EXISTS`). New databases get all ten (plus any future `SOURCE_DEFINITIONS` keys) from `applyHistoryImportSchema`. Not a breaking schema change.

#### R17 — async `getGitContext` on `ProcessExecutor`

**Problem.** ADR-023 A2 made `ProcessExecutor` the canonical type. `identity.ts:68-71` still default-constructs `@deprecated` `BunSyncProcessExecutor`. Sync `runSync` is the last production reason for that class in this repo (0030 C4).

**Fix.**

```ts
export async function getGitContext(
    workspacePath: string,
    executor: ProcessExecutor = nodeBunFactory.createProcessExecutor(),
): Promise<string | null> {
    const branch = await runGit(executor, ['-C', workspacePath, 'branch', '--show-current']);
    // … same dirty-count logic, using await runGit
}

/** @deprecated Use {@link getGitContext}. Kept for one release for sync callers. */
export function getGitContextSync(
    workspacePath: string,
    executor: SyncProcessExecutor = new BunSyncProcessExecutor(),
): string | null { /* current body */ }
```

`runGit` async variant calls `executor.run({ command: 'git', args, rejectOnError: false, forceBuffered: true })`.

**In-tree updates:** `identity.test.ts` fake becomes `{ run: async ({ command, args }) => ({ … }) }`; the real-git test `await getGitContext(dir)`. README `:288-290` uses `await`. No orchestrator caller exists.

**Rejected.** Dual same-name overload (TS cannot mix sync/async returns cleanly). Only adding `getGitContextAsync` and leaving the default sync — that would not close R17. Deleting `BunSyncProcessExecutor` from ts-runtime — out of scope.

**Breaking.** `getGitContext` return type `string | null` → `Promise<string | null>`. CHANGELOG `BREAKING CHANGE:` footer. Classify as `feat!` or `fix!` on `@gobing-ai/ts-ai-runner`.

**ADR.** Addendum under ADR-023 (same entry, dated today): A2 leftover `getGitContext` default is closed; `BunSyncProcessExecutor` remains a deprecated runtime export for other out-of-repo sync callers.

#### Do not

- Edit `~/.agents/` or `~/.grok/` or Claude hooks.
- Edit spur skills unless a follow-up harness task is opened; if so, the source of truth is `/Users/robin/xprojects/spur-new`.
- Re-open 0060 MUST items.
### Plan
1. Re-read `packages/llm-jsonl-importer/src/schema-sql.ts`, `jsonl-importer-dao.ts:73-114`, `sources.ts:154-214`, `types.ts:6-16`, `packages/ai-runner/src/identity.ts:67-86`, `tests/identity.test.ts`, `packages/ai-runner/README.md:285-290`, ADR-023.
2. R16 — strip `history_etl_*` from the static SQL; loop `SOURCE_DEFINITIONS` in `applyHistoryImportSchema`; fix comments.
3. Tests — `schema-sql.test.ts` negative assertion; new apply-schema test for grok/omp/agy/pi tables. `bun test packages/llm-jsonl-importer/tests/`.
4. R17 — async `getGitContext` + deprecated `getGitContextSync`; update tests and README.
5. `bun test packages/ai-runner/tests/identity.test.ts`.
6. ADR-023 addendum + CHANGELOG (breaking for R17, fix for R16) + importer README if it claims static ETL DDL.
7. `bun run spur-check` and `bun run build`.
8. Fill Solution (`file:line`), Testing (MET + pasted exits), Review dispositions FIXED.
9. Stop. Do not take drive-by refactors.
### Solution
Implemented 0060 leftovers R16 + R17 (two surgical package changes; no new packages, no harness/skill edits).

| Change | Evidence |
| --- | --- |
| Removed every static `history_etl_*` CREATE block (R1) | `packages/llm-jsonl-importer/src/schema-sql.ts:1` (module comment) — `rg "history_etl_" schema-sql.ts` returns only the docstring WHY line, no CREATE |
| Static SQL keeps checkpoint, ledger, typed contract tables | `packages/llm-jsonl-importer/src/schema-sql.ts:17` (checkpoint), `:25` (ledger), `:33` (history_message), `:65` (history_tool_call) |
| `applyHistoryImportSchema` loops `SOURCE_DEFINITIONS` → `ensureTargetTables` (R2) | `packages/llm-jsonl-importer/src/jsonl-importer-dao.ts:93` (fn), `:100-101` (the loop) |
| `ETL_TABLE_DDL` remains the only ETL CREATE text | `packages/llm-jsonl-importer/src/jsonl-importer-dao.ts:60` (`ETL_TABLE_DDL`) |
| `ensureTargetTables` now single-owner for all built-in ETL tables; comment updated | `packages/llm-jsonl-importer/src/jsonl-importer-dao.ts:106` (docstring), `:117` (fn) |
| Built-in source registry (10 sources incl. grok/omp/agy) | `packages/llm-jsonl-importer/src/sources.ts:158` (`SOURCE_DEFINITIONS`) |
| Async `getGitContext` + default `ProcessExecutor` (R4) | `packages/ai-runner/src/identity.ts:80` (fn), `:82` (default `nodeBunFactory.createProcessExecutor()`), `:110` (async `runGit`) |
| Deprecated sync escape hatch `getGitContextSync` (R5) | `packages/ai-runner/src/identity.ts:100`, `@deprecated` JSDoc `:96`, sync `runGitSync` `:122` |
| Identity tests cover async default + fake `run` + deprecated sync | `packages/ai-runner/tests/identity.test.ts:50` (async), `:88` (fake-run test), `:95` (sync helper test) |
| README uses `await getGitContext` (R5/R6) | `packages/ai-runner/README.md:290` |
| Importer README table list is accurate (no static-SQL-creates-ETL claim) | `packages/llm-jsonl-importer/README.md:128` |
| ADR-023 dated addendum closes A2 leftover + records R16 | `docs/00_ADR.md:348` |
| CHANGELOG: R16 fix entry | `CHANGELOG.md:21` |
| CHANGELOG: R17 BREAKING CHANGE entry | `CHANGELOG.md:34` |

**Close-out (2026-08-12, post-verify leftovers).**
- `ensureTargetTables` WHY no longer claims the static schema created ETL tables (`packages/llm-jsonl-importer/src/jsonl-importer-dao.ts:114-115`).
- `getGitContextSync` success path covered (`packages/ai-runner/tests/identity.test.ts` sync-success case).
- `runJsonlImport('agy', …)` on a fresh schema (`packages/llm-jsonl-importer/tests/forensic-contract.test.ts` R3 agy case).
- Importer README `VALID_TABLE_NAME` regex corrected to `/^history_[a-z_]+$/` (`packages/llm-jsonl-importer/README.md:148`).
### Testing
Independent re-verify 2026-08-12 (`/sp-dev-verify 0061 --auto --next --force --focus all --fix all`). Status was already `done`; `--force` re-audited. Implementation is still uncommitted working-tree (plus this task file). `--fix all` found no UNMET/PARTIAL core items. `--next: no-op - task already terminal (done)`.

Coverage: 99.42% functions / 99.22% lines (`bun run spur-check` this run; 1949 tests, 0 fail).

**Per-Requirement Traceability**

| Req | Status | Evidence |
| --- | --- | --- |
| R1 | MET | `packages/llm-jsonl-importer/src/schema-sql.ts:11-85` has checkpoint/ledger/`history_message`/`history_tool_call` + indexes; no `CREATE TABLE … history_etl_`. `packages/llm-jsonl-importer/tests/schema-sql.test.ts:18-21` pass this run |
| R2 | MET | `packages/llm-jsonl-importer/src/jsonl-importer-dao.ts:73-81` `ETL_TABLE_DDL`; `:100-101` loops `SOURCE_DEFINITIONS` → `ensureTargetTables`; `:117-126` typed-table skip. `packages/llm-jsonl-importer/tests/jsonl-importer-dao.test.ts:313-328` SELECT empty `history_etl_pi`/`grok`/`omp`/`agy` on fresh adapter pass this run |
| R3 | MET | Fresh-DB imports this run: antigravity/opencode/openclaw/omp/pi/claude/codex (`packages/llm-jsonl-importer/tests/importer.test.ts`); grok (`packages/llm-jsonl-importer/tests/forensic-contract.test.ts:223-228`). `history_etl_agy` exists after apply (R2 test). Typed tables from static SQL (`schema-sql.ts:29,56`; forensic-contract typed-schema tests pass) |
| R4 | MET | `packages/ai-runner/src/identity.ts:80-83` async + `nodeBunFactory.createProcessExecutor()` default; `:114-117` `executor.run`. `packages/ai-runner/tests/identity.test.ts:51-66` null on fail; `:83-102` fake `run` → `branch: main`; `:69-81` default path (no `BunSync` construct) pass this run |
| R5 | MET | `packages/ai-runner/src/identity.ts:97-102` `@deprecated` `getGitContextSync` + `BunSyncProcessExecutor` default. `packages/ai-runner/tests/identity.test.ts:105-118` sync null. README `packages/ai-runner/README.md:290` `await getGitContext` |
| R6 | MET | `CHANGELOG.md:21` R16 fix; `CHANGELOG.md:34` R17 BREAKING; `docs/00_ADR.md:348-356` ADR-023 addendum closes A2 leftover; importer README `packages/llm-jsonl-importer/README.md:124-132` does not claim static SQL creates every `history_etl_*` |
| R7 | MET | `bun run spur-check` exit 0 this run (1949 pass / 0 fail; 48+2 rules); `bun run build` exit 0 this run (8 packages). No `.skip`, no new `biome-ignore` |

**Acceptance Criteria Verification**

| AC | Status | Evidence Type | Evidence |
| --- | --- | --- | --- |
| Scenario: R1 — static schema has no history_etl_* CREATE | MET | test | `packages/llm-jsonl-importer/tests/schema-sql.test.ts:18-21` 23 pass / 0 fail this run (dao+schema files) |
| Scenario: R2 — applyHistoryImportSchema still materializes every built-in ETL table | MET | test | `packages/llm-jsonl-importer/tests/jsonl-importer-dao.test.ts:313-328` pass this run; `packages/llm-jsonl-importer/src/jsonl-importer-dao.ts:100-101` |
| Scenario: R3 — built-in ETL sources still import on a fresh DB | MET | test | importer.test.ts + forensic-contract.test.ts 58 pass this run; typed tables from `packages/llm-jsonl-importer/src/schema-sql.ts:29,56` |
| Scenario: R4 — getGitContext is async ProcessExecutor | MET | test | `packages/ai-runner/tests/identity.test.ts:51-102` 7 pass this run; `packages/ai-runner/src/identity.ts:80-83` |
| Scenario: R5 — deprecated sync helper remains | MET | test | `packages/ai-runner/tests/identity.test.ts:105-118`; `@deprecated` at `packages/ai-runner/src/identity.ts:97`; README `:290` |
| [docs-only] Scenario: R6 — docs and ADR | MET | static-ref | `CHANGELOG.md:21,34`; `docs/00_ADR.md:348-356`; `packages/llm-jsonl-importer/README.md:124-132`; `packages/ai-runner/README.md:290` |
| Scenario: R7 — gates | MET | command | `bun run spur-check` exit 0; `bun run build` exit 0 this run |

**Commands this verify (all exit 0):**

```
(cd packages/llm-jsonl-importer && bun test tests/schema-sql.test.ts tests/jsonl-importer-dao.test.ts)
  → 23 pass / 0 fail
(cd packages/llm-jsonl-importer && bun test tests/importer.test.ts tests/forensic-contract.test.ts)
  → 58 pass / 0 fail
(cd packages/ai-runner && bun test tests/identity.test.ts)
  → 7 pass / 0 fail
bun run spur-check → exit 0, 1949 pass / 0 fail, 48+2 rules, 99.42% funcs / 99.22% lines
bun run build → exit 0 all 8 packages
```

**Design conformance:** R16 steps 1–5 DONE (static ETL CREATE removed; apply loops `SOURCE_DEFINITIONS`; `ETL_TABLE_DDL` only CREATE text; comments updated; tests added). R17 async + deprecated sync hatch DONE. `ensureTargetTables` still exported (`packages/llm-jsonl-importer/src/jsonl-importer-dao.ts:681`). ADR-023 addendum + CHANGELOG breaking/fix DONE.

**SECUA (focus all):** no P1–P3. Post-verify leftovers closed (sync-success test, ensureTargetTables comment, agy import, README regex). Remaining P4: frontmatter `name` still the vacated session-bottleneck title (CLI cannot rename; Q&A keeps it for WBS stability).

**Fix-pass artifacts:** Testing rewrite only — expanded three short `file:line` citations to repo-relative paths so `L4.stale-line-anchor` cleared (no source change). Verdict written to `.spur/run/0061-verdict.json` and `.spur/run/0061-verify-answer.txt`.
### Review
Self-review of the implemented R16/R17 patch (2026-08-12, task 0061). Inline stage provenance: stages implement/test/review executed inline in session `msqhr3cu-61gqt8gt` (inline pipeline driver, `--agent inline`).

| Priority | Finding | File:Line | Disposition |
| --- | --- | --- | --- |
| P1 | R16 regression risk: migrate-then-insert callers | `packages/llm-jsonl-importer/src/jsonl-importer-dao.ts:100` | FIXED — `applyHistoryImportSchema` loops `SOURCE_DEFINITIONS` so all built-in ETL tables exist after schema apply; covered by `jsonl-importer-dao.test.ts:314` |
| P1 | R17 breaking: every in-tree `getGitContext` caller must `await` | `packages/ai-runner/src/identity.ts:80` | FIXED — only caller was `identity.test.ts`; rewritten to async. No production orchestrator path calls it (confirmed by `rg getGitContext`) |
| P2 | R16 drift could recur if a future source is added only to `SOURCE_DEFINITIONS` | `packages/llm-jsonl-importer/src/sources.ts:158` | FIXED by construction — `SOURCE_DEFINITIONS` is now the single owner; `schema-sql.ts` has no `history_etl_*` CREATE to drift |
| P2 | `getGitContextSync` left as a footgun | `packages/ai-runner/src/identity.ts:100` | ACCEPTED — required by R5 for one-release sync-caller compatibility; `@deprecated` JSDoc + test |
| P3 | `nodeBunFactory` import extends ai-runner's runtime surface | `packages/ai-runner/src/identity.ts:1` | ACCEPTED — already a `workspace:*` dependency; factory is the ADR-023 A2 canonical default |
| P4 | Prior 0061 body (session hooks / `~/.agents/` skill paths) vacated | task frontmatter `name` | KNOWN — name kept for WBS stability; Background section documents the vacation. Not in scope. |
### References
- Parent / predecessor: task `0060` (done). Testing rows R16/R17 were DEFERRED with “WBS to assign”; this WBS is that assignment.
- 0060 Design MAY / R16–R17 text; 0060 Solution deferral paragraphs.
- Prior: `0030` architecture candidates 2 and 1; ADR-023 A2 (`docs/00_ADR.md` ~337).
- Code anchors (re-read this run):
  - `packages/llm-jsonl-importer/src/schema-sql.ts:1-140`
  - `packages/llm-jsonl-importer/src/jsonl-importer-dao.ts:73-114`
  - `packages/llm-jsonl-importer/src/sources.ts:154-214`
  - `packages/llm-jsonl-importer/src/types.ts:6-16`
  - `packages/llm-jsonl-importer/tests/schema-sql.test.ts:1-16`
  - `packages/ai-runner/src/identity.ts:67-86`
  - `packages/ai-runner/tests/identity.test.ts:50-78`
  - `packages/ai-runner/README.md:285-290`
  - `packages/runtime/src/process-executor.ts:622` (`BunSyncProcessExecutor`)
- Process SSOT if harness work appears later: `/Users/robin/xprojects/spur-new` (not `~/.agents/`).
### History
- 2026-08-12T18:42:55.709Z backlog → todo (system)
- 2026-08-12T19:39:03.350Z todo → wip (system)
- 2026-08-12T19:44:54.591Z wip → testing (system)
- 2026-08-12T19:45:00.412Z testing → done (system)
### Notes
**For the next coding agent**

You are implementing **0060 leftovers R16 + R17**, not reviewing `packages` and not patching Grok/Claude skills.

```bash
spur task show 0061
spur task update 0061 wip
```

**R16 pitfall:** do not only delete the seven CREATE blocks. `applyHistoryImportSchema` must still create every `SOURCE_DEFINITIONS` ETL table or grok/omp/agy (and anyone who migrate-then-inserts) regress. Loop `ensureTargetTables`.

**R16 pitfall:** typed tables `history_message` / `history_tool_call` stay in the static SQL. `ensureTargetTables` already skips them via `TYPED_TABLE_COLUMNS`.

**R17 pitfall:** do not leave a sync `getGitContext` as the default export. The 0060 deferral is specifically “async + ProcessExecutor default”. Provide `getGitContextSync` under the old semantics.

**R17 pitfall:** fake executors in `identity.test.ts` must implement `run`, not only `runSync`.

**Skill edits:** none in this task. If a later task touches `/sp-dev-*`, edit `/Users/robin/xprojects/spur-new`, never `~/.agents/`.

**Done:** R1–R7 MET with tests/commands in Testing; Review rows FIXED; `spur-check` + `build` green.
