---
template: standard
schema_version: 1
name: "Fix 2026-08-12 packages SECUA and architecture review findings"
description: ""
status: testing
type: task
profile: standard
feature_id: null
parent_wbs: null
priority: P1
tags: []
dependencies: []
ac_numbering: task-local
created_at: "2026-08-12T18:30:12.815Z"
updated_at: "2026-08-12T19:09:09.354Z"
---

## 0060. Fix 2026-08-12 packages SECUA and architecture review findings

### Background
Handoff from `/sp-dev-review packages --focus all` (2026-08-12, path mode, inline). `--fix` is a **deprecated no-op** on review — this task is the remediation vehicle.

**Verdict of the review:** PARTIAL. 0 blockers, 12 majors, plus minors/advisories. Prior task 0030 (`Bun.which` in `packages/ai-runner/src/identity.ts`) is still gone. Drizzle stays inside `ts-db`. The `ts-infra` main barrel stays portable. No `console.*` in package `src`. No skipped tests.

**Why a task, not a drive-by fix:** the set spans eight packages, includes one published prototype-pollution, two public-contract changes (ProcessExecutor env, D1Adapter barrel), and one ADR-020 residual (reseed). A single implementer (or a sequenced `/sp-dev-run`) needs a frozen, evidence-backed change-map — not a second review.

**In-scope (MUST — 12 majors):**

| Id | Dim | One-line |
|----|-----|----------|
| F1 | security | `deFlattenKeys` prototype-pollutes on `__proto__.*` keys |
| F2 | security | Documented `allowRemote` SSRF gate is never read |
| F3 | security | `walkDir` follows symlink cycles / can escape the start root |
| F4 | security | `ActionRedactor` is dead; shell stdout is persisted raw |
| F5 | correctness | `run()` merges `env`; `runStreaming()` replaces it |
| F6 | correctness | `reseedRun` is not atomic and wipes `effectiveVars` |
| F7 | correctness | Unsupported cron still fires every 60s |
| F8 | correctness | `_ensuredTables` is process-global, not per-db |
| F9 | efficiency | Full import: N+1 ledger lookups + non-atomic record/ledger writes |
| F10 | efficiency | `drainPending` claims the entire inbox |
| C1 | architecture | Main `ts-db` barrel value-exports `D1Adapter` (pulls `drizzle-orm/d1`) |
| C2 | architecture | Both engines smash abs paths into the shared extension loader |

**In-scope (SHOULD — minors):** M1 redaction defaults, M2 Gemini auth heuristic, M3 `scanFiles` unbounded buffer.

**In-scope (MAY — advisory, do last or record as follow-up with a one-line ADR note):** A1 importer table/DDL locality (0030 re-eval), A2 `BunSyncProcessExecutor` still the `getGitContext` default (0030 re-eval / ADR-023 A2 leftover).

**Confirmed this session (do not re-litigate):**

- F1 live repro: `deFlattenKeys({ "__proto__.polluted": "\"pwned\"" })` made `({}).polluted === "pwned"` and `Object.prototype.hasOwnProperty("polluted") === true`.
- F2: `allowRemote` appears only at `packages/runtime/src/schema-validation.ts:39`. `readSchema` (`:345-353`) gates solely on `options.fetch`. README `:264-273` claims `{ allowRemote: true }` enables a built-in fetch — that path does not exist (`schema-validation.test.ts:63-66`).
- F5: task 0056 test covers `run()` only (`process-executor.test.ts:262-286`). `runStreaming` passes `env` straight to `Bun.spawn` (`process-executor.ts:363`).
- F6: resume reads `effectiveVars` from the latest snapshot (`service.ts:168-173`); `reseedRun` overwrites the snapshot with `{ reseeded, reseededAt }` (`persistence.ts:252-253`).

**Out of scope:** new features, new packages, rewriting the cron parser to support full 5-field cron, making `desiredHashes` a durable table unless the F9 batch path needs it, changing ADR-010 engine *concepts*, editing `.github/workflows/`.
### Requirements
Implement in the Plan order. Do not skip a MUST item to polish a MAY item.

R18. Process: before any public-contract change (F5 env merge, C1 barrel export removal, F7 throw-on-unsupported-cron) add the ADR addendum or CHANGELOG `Fixed`/`Breaking` note specified in Design. Do not invent a new ADR number for a pure bugfix (F1, F2, F4, F8). `bun run spur-check` and `bun run build` must exit 0. No `.skip`, no `biome-ignore` added to silence the check, no `--no-verify`. Every MUST item has at least one new or extended regression test that fails against the unfixed source. Package READMEs that document a changed contract are updated in the same commit. Internal deps stay `workspace:*`. drizzle-orm stays inside `ts-db` (ADR-005). Platform APIs stay behind sanctioned seams (ADR-011/014).

R1. `deFlattenKeys` never assigns through `Object.prototype` (or `Function.prototype`) for keys/segments `__proto__`, `constructor`, or `prototype`. `deepMerge` remains the reference guard. Confirmed repro must go green.

R2. Remote `$schema` fetch requires both `allowRemote === true` and an explicit `fetch`. `allowRemote` alone still refuses. `fetch` alone still refuses. README matches the code (no phantom built-in fetch). Default stays fail-closed.

R3. `walkDir` cannot stack-overflow or OOM on a cyclic directory symlink, and cannot walk outside the start root via a symlink. Legitimate directory symlinks inside the start root must still be traversed (importer / rule-engine walk `$HOME/...` trees that are often symlinks into a dotfiles repo). Track visited real paths (dev+ino or `realPath`); do not blindly `lstat`-skip every directory symlink.

R4. `WorkflowPersistenceAdapter.saveActionFinalize` applies `redactor` when provided, and the built-in shell action path never persists raw `stdout`/`stderr` by default. `runActionStep` must pass a redactor (default or caller-supplied). The unused `_redactor` parameter is removed.

R5. `ProcessExecutor.run` and `ProcessExecutor.runStreaming` share one `env` contract: a partial `env` extends the parent environment (execa `extendEnv: true` / equivalent merge). Replacement is opt-in via a new explicit flag (e.g. `envMode: 'replace'`), default merge. A `runStreaming` twin of the 0056 sentinel test must pass.

R6. `reseedRun` persists the new state snapshot and the `__reseed__` transition atomically via `commitTransition` (ADR-020). The new snapshot preserves previous `effectiveVars` (merge `{ ...prev, reseeded, reseededAt }`). Resume after reseed still sees HITL/runtime vars.

R7. `NodeSchedulerAdapter.parseInterval` / `register` throws (or refuses to start a timer) on unsupported cron expressions. `0 3 * * *` must not silently run every 60s. The existing warn-and-fallback path is deleted. Supported forms stay: positive raw ms, `* * * * *`, `*/N * * * *` with N > 0.

R8. Importer table-ensure state is per `DbAdapter` instance (or is removed in favour of idempotent `CREATE TABLE IF NOT EXISTS`). Opening a second database in the same process after creating a custom ETL table on the first must still create the table.

R9. Incremental/full JSONL import no longer does one `ledgerExists` SELECT per record. Lookups are chunked (`IN (...)` of at most 200 hashes). `insertRecord` + `insertLedger` for the same record commit in one `db.batch`. A crash between those two writes is impossible.

R10. `InboxMessageDao.drainPending` accepts a positive `limit` (default 100). A backed-up inbox is claimed in pages. `TeamOrchestrator.flushInbox` / `MessageStore` loop until a short page (or expose the limit). Existing no-arg call sites keep compiling.

R11. `@gobing-ai/ts-db` main barrel does not value-export `D1Adapter`. Consumers use `createDbAdapter({ driver: 'd1', binding })` or `@gobing-ai/ts-db/d1`. `InternalDb` stays type-only / `@internal`. Record as an ADR-005 addendum (barrel leak, not a new facade).

R12. Rule-engine and dual-workflow-engine stop reconstructing `(dirname, basename)` so `assertRelativeExtensionPath` is a no-op. Engine refs carry authored relative path + declaring directory (the shared `ExtensionRef` shape). The duplicated `..` pre-check blocks are deleted. ADR-022 `realPath` confinement stays the filesystem-level guard.

R13. Default redaction rules also match `xai-…` keys, `AKIA…` AWS ids, and `Bearer <jwt>`. Existing `sk-` / assignment / email rules stay.

R14. Gemini auth probe no longer treats any `settings.json` containing `/auth|token|key/i` as authenticated. Require a credential-shaped field (e.g. non-empty `apiKey` / `accessToken` / OAuth token object) or treat the file as `unknown` / `unauthenticated` unless those keys exist.

R15. `scanFiles` does not hold the entire corpus in memory unbounded: per-file size cap (e.g. 2 MiB, skip + diagnostic) or stream one file at a time (do not push every `content` into one array before evaluators run). Prefer the per-file cap + sequential evaluate if a full stream refactor is too large.

R16. MAY: concentrate importer ETL table ownership. Static `HISTORY_IMPORT_SCHEMA_SQL` keeps checkpoint/ledger/typed contract tables only; every `history_etl_*` table is created via `ETL_TABLE_DDL` after `targetTableFor`. Implement or defer in Solution.

R17. MAY: `getGitContext` becomes async and defaults to `ProcessExecutor` (not `new BunSyncProcessExecutor()`). Callers of the sync signature are updated or the sync overload is deprecated with a documented removal path. Implement or defer in Solution.

### Acceptance Criteria
```gherkin
Feature: 2026-08-12 packages review findings are fixed

  Scenario: R1 — deFlattenKeys does not pollute Object.prototype
    Given a hostile key "__proto__.polluted" with JSON value "\"pwned\""
    When deFlattenKeys is called
    Then ({}) as { polluted?: unknown }).polluted is undefined
    And Object.prototype.hasOwnProperty("polluted") is false
    And the same guard applies to "constructor.prototype.x" segments

  Scenario: R2 — remote schema fetch is dual-gated
    Given a config whose $schema is an https URL
    When parseStructuredConfig / loadStructuredConfig is called with no options
    Then it throws StructuredConfigSchemaError mentioning remote fetch is refused
    When called with { allowRemote: true } and no fetch
    Then it still throws
    When called with { fetch } and allowRemote omitted or false
    Then it still throws
    When called with { allowRemote: true, fetch }
    Then the remote schema is fetched and validation proceeds

  Scenario: R3 — walkDir is cycle-safe and root-confined
    Given a directory that contains a symlink to itself or to an ancestor
    When walkDir is invoked on that directory
    Then it returns in bounded time without throwing a stack overflow
    And it does not visit the same real directory twice
    Given a symlink inside the start root that points outside the start root
    When walkDir runs
    Then the outside target is not descended into
    Given a directory symlink inside the start root that points to another directory still under the start root
    When walkDir runs
    Then the target's files are still discovered

  Scenario: R4 — shell action results are redacted before persist
    Given a ShellActionRunner that returns stdout containing a secret token
    When runActionStep finalizes the action against DbWorkflowPersistenceAdapter
    Then action_runs.result_json does not contain the raw secret
    And a caller-supplied ActionRedactor is invoked when provided
    And the unused _redactor parameter is gone (the parameter is used)

  Scenario: R5 — run and runStreaming share env merge
    Given process.env contains a unique sentinel
    When NodeProcessExecutor.runStreaming is called with env: { SPUR_RUN_ID: "x" }
    Then the child sees both the sentinel and SPUR_RUN_ID
    And run() still passes the existing 0056 test
    When envMode is "replace" (or the documented opt-in)
    Then the child does not see the parent sentinel

  Scenario: R6 — reseed is atomic and preserves effectiveVars
    Given a paused run whose latest snapshot data includes effectiveVars.__hitlAnswer
    When reseedRun moves the run to another declared state
    Then the new snapshot still contains effectiveVars.__hitlAnswer
    And the snapshot and __reseed__ transition are written via commitTransition / db.batch
    When a stub persistence throws after the first of the old two writes
    Then the adapter no longer has a split-write path (single commitTransition call)

  Scenario: R7 — unsupported cron does not schedule
    Given NodeSchedulerAdapter
    When register("0 3 * * *", action) or start() is invoked
    Then it throws (RangeError or a named error) mentioning the expression is unsupported
    And no setInterval is created for that entry
    And "* * * * *", "*/5 * * * *", and "60000" still schedule

  Scenario: R8 — importer table cache is per adapter
    Given two distinct DbAdapter instances (two temp sqlite files)
    When a custom SourceDefinition target table is ensured on adapter A
    Then adapter B still creates that table on first insert (no "no such table")

  Scenario: R9 — import lookups and writes are batched
    Given an incremental import of N>1 new records
    Then ledger existence is queried in chunks of at most 200 hashes
    And each accepted record's target-row insert and ledger insert commit in one db.batch
    And a crash between those two statements is impossible

  Scenario: R10 — inbox drain is paged
    Given 250 queued messages for one toId
    When drainPending(toId) is called with default options
    Then at most 100 rows are returned and marked injected
    When the caller loops until a short page
    Then all 250 are eventually drained
    And MessageStore / TeamOrchestrator still compile and drain fully

  Scenario: R11 — ts-db main barrel does not load D1Adapter
    Given packages/db/src/index.ts
    Then it does not value-export D1Adapter
    And createDbAdapter({ driver: "d1", binding }) still works
    And @gobing-ai/ts-db/d1 still exports D1Adapter
    And an ADR-005 addendum records the barrel-leak close

  Scenario: R12 — engines pass authored relative paths to the shared loader
    Given a rule-engine or workflow extension declared as "./exts/foo.ts" from a config dir
    Then loadExtensionModules receives path "./exts/foo.ts" (or the authored relative string) and baseDir = declaring dir
    And there is no dirname/basename smash that would make assertRelativeExtensionPath a no-op
    And a path containing ".." is still rejected
    And ADR-022 realPath confinement still rejects symlink escape

  Scenario: R13 — default redaction covers xai, AKIA, Bearer JWT
    Given redactValue("xai-abcdefghijklmnopqrstuv")
    Then the value is replaced
    Given redactValue("AKIAIOSFODNN7EXAMPLE")
    Then the value is replaced
    Given redactValue("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.aa.bb")
    Then the token is replaced
    And existing sk- / assignment / email rules still match

  Scenario: R14 — Gemini auth is not a loose substring match
    Given ~/.gemini/settings.json containing only {"theme":"dark","apiKey":""} or {"ui":{"showAuthBanner":true}}
    When isAuthenticated("gemini", ctx) runs
    Then the result is not "authenticated"
    Given a settings object with a non-empty credential field (apiKey / accessToken / tokens)
    Then the result is "authenticated"

  Scenario: R15 — scanFiles does not buffer unbounded file bodies
    Given a scoped file larger than the documented cap
    When scanFiles / regex evaluator runs
    Then that file is skipped or streamed rather than held in a giant content array
    And smaller files still produce the same findings

  Scenario: R16 — importer ETL tables are created via one DDL owner
    Given HISTORY_IMPORT_SCHEMA_SQL and a built-in source such as grok
    When the implementer ships R16 rather than deferring it
    Then history_etl_* tables are created via ETL_TABLE_DDL after targetTableFor
    And the static schema SQL keeps only checkpoint, ledger, and typed contract tables
    When the implementer defers R16
    Then Solution names the deferral and this scenario is N/A

  Scenario: R17 — getGitContext no longer defaults to BunSyncProcessExecutor
    Given packages/ai-runner/src/identity.ts
    When the implementer ships R17 rather than deferring it
    Then getGitContext is async and defaults to ProcessExecutor
    And new BunSyncProcessExecutor() is not the production default
    When the implementer defers R17
    Then Solution names the deferral and this scenario is N/A

  Scenario: R18 — process and quality gates
    Given the working tree after the implementation
    When bun run spur-check and bun run build run
    Then both exit 0
    And no test is skipped to go green
    And CHANGELOG or an ADR addendum exists for each public-contract change in Design
```

### Q&A
**Q: One task or many?**
A: Operator asked for a single implementation-ready task file. Keep one WBS. If the implementer must split (e.g. C1 breaking-change needs its own release note cycle), spawn follow-ups via `spur task create` and `spur task deps 0060 add <wbs>` — do not silently shrink MUST scope.

**Q: Is F7 a breaking change?**
A: Unsupported cron was already documented as unsupported (0032 warn). Throwing is the honest contract. CHANGELOG `Fixed`, not `BREAKING`, unless you find in-repo callers passing real cron fields.

**Q: Is C1 a breaking change?**
A: Yes for anyone who `import { D1Adapter } from '@gobing-ai/ts-db'`. In-repo should already use `createDbAdapter`. Use a `BREAKING CHANGE:` footer if grep finds published-API usage; otherwise `fix:` + ADR-005 addendum is enough. Keep `@gobing-ai/ts-db/d1`.

**Q: Can walkDir skip all symlinks?**
A: No. That would break importer/rule-engine discovery of home trees that are symlinks into a dotfiles repo (ADR-023 A1). Confine to the start root; still follow in-root directory symlinks; break cycles with a visited realpath set.

**Q: Should `--fix` have been applied during review?**
A: No. `/sp-dev-review --fix` is a deprecated no-op. This task is the remediation.

**Q: What if a SHOULD item conflicts with a MUST?**
A: Ship MUST. Defer SHOULD in Solution with a one-line reason.

**Q: New dependencies?**
A: None. No new runtime, linter, or formatter.
### Design
**Chosen approach:** one sequenced implementation of the 12 MUST items (F1–F10, C1, C2), then SHOULD (R13–R15), then MAY (R16–R17) or a recorded deferral. No new packages. No speculative framework. Each item is a surgical patch with a regression test that fails on the unfixed source.

Do **not** treat this as a redesign of workflow, importer, or the plugin core. Reuse existing seams: `commitTransition` / `DbAdapter.batch` (ADR-020), `LoadExtensionsOptions.realPath` (ADR-022), `VALID_TABLE_NAME`, `ActionRedactor`, `ProcessExecutor` interface (ADR-023 A2).

**Implementation order (mandatory — reduces conflict and ships security first):**

1. F1 `ts-utils` (isolated)
2. F2 `ts-runtime` schema-validation
3. F3 `ts-runtime` walkDir
4. F5 `ts-runtime` ProcessExecutor env
5. F4 + F6 `ts-dual-workflow-engine` (same package; F6 uses existing `commitTransition`)
6. F7 `ts-infra` scheduler
7. F8 + F9 `ts-llm-jsonl-importer`
8. F10 `ts-db` + `ts-ai-runner` MessageStore
9. C1 `ts-db` barrel (ADR-005 addendum first)
10. C2 shared loader + both engines
11. R13–R15 minors
12. R16–R17 or defer in Solution

**Rejected alternatives (global):**

- One mega-refactor / new abstraction layer across packages — rejected (surgical).
- “Document the bug instead of fixing” for F1/F2/F4/F5/F6 — rejected; these are defects, not decisions.
- Implementing full 5-field cron — rejected (R7 is fail-loud, not a parser rewrite).

---

#### F1 — `deFlattenKeys` prototype pollution

**Where:** `packages/utils/src/object.ts:52-64`. Guard reference: `deepMerge` at `:19-21`. Tests: `packages/utils/tests/object.test.ts` (add next to the `deepMerge` `__proto__` case at `:36-48`).

**Bug:** `current[part]` for `part === '__proto__'` returns `Object.prototype`. `isPlainObject(Object.prototype)` is true, so the walker does not replace it, then `current[last] = …` creates an own property on `Object.prototype`. Live-repro’d 2026-08-12.

**Fix:** Before walking or assigning, reject segments in `{ __proto__, constructor, prototype }` (skip the key, or throw `Error('Invalid object key segment')`). Prefer **skip** (symmetric with `deepMerge` skipping `__proto__`) so flatten→deflate of hostile input is a no-op rather than a throw that callers must catch. Build nested objects with `Object.create(null)` *or* use `Object.hasOwn` + plain `{}` **and** never read `current[part]` when `part` is forbidden.

**Do not:** change `flattenKeys` output format; change `isPlainObject` to reject `Object.prototype` globally (would surprise other callers) unless you also audit those callers.

**Test (must fail on unfixed source):**

```ts
deFlattenKeys({ '__proto__.polluted': '"pwned"' });
expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
expect(Object.prototype.hasOwnProperty('polluted')).toBe(false);
```

Clean `delete (Object.prototype as { polluted?: unknown }).polluted` in `afterEach` if you assign during the red test.

---

#### F2 — `allowRemote` dead gate

**Where:** `packages/runtime/src/schema-validation.ts:31-39` (option), `:345-353` (`readSchema`). Docs: `packages/runtime/README.md:264-273`. Tests: `packages/runtime/tests/schema-validation.test.ts:59-80` — **the test at :77 currently asserts that `fetch` alone succeeds**. That test encodes the bug. Flip it.

**Fix:**

```ts
if (isRemoteRef(schemaLocation)) {
  if (options.allowRemote !== true || options.fetch === undefined) {
    throw new StructuredConfigSchemaError(
      `Refusing to fetch remote JSON schema "${schemaLocation}": pass allowRemote: true and a fetch implementation`,
    );
  }
  const response = await options.fetch(schemaLocation);
  …
}
```

**Do not** add a built-in `globalThis.fetch` default. The README’s `{ allowRemote: true }` “built-in fetch, time-bounded” line is false — delete it. New README row: both flags required; no network unless the embedder injects `fetch`.

**No ADR.** Bugfix + doc correction.

---

#### F3 — `walkDir` symlink cycles / escape

**Where:** `packages/runtime/src/fs.ts:51-66`. `FileSystem.stat` follows links (`file-system-node.ts:102-104` uses `statSync`).

**Do not** skip every directory symlink. Importer default roots under `$HOME` are commonly symlinks into a dotfiles tree; skipping them would silently import nothing (regression of task 0042 / ADR-023 A1).

**Fix (recommended):**

- Resolve `startReal = fs.realPath?.(path) ?? path`.
- Keep `visited: Set<string>` of real directories.
- For each entry, `entryReal = fs.realPath?.(fullPath) ?? fullPath`.
- If `entryStat.isDirectory()`:
  - if `visited.has(entryReal)` → skip (cycle).
  - if `entryReal !== startReal && !entryReal.startsWith(startReal + '/')` (and Windows `\\` variant, same prefix rule as `extension-loader.ts:122`) → skip (escape).
  - else `visited.add(entryReal)` and recurse.
- If `realPath` is missing (in-memory / CF stubs), keep today’s follow-`stat` behaviour (no ambient capability). Node `createNodeFileSystem()` already has `realPath`.

**Tests:** cyclic `dir/loop -> dir`; escape `dir/out -> /tmp/outside` not listed; in-root symlink `dir/link -> dir/nested` still lists `dir/nested/file`. Use `fileSystem.realPath` on a real temp dir (Node).

**No new FileSystem method required.** Optional later: `lstat` on the interface — out of scope unless `stat` following blocks confinement; prefer `realPath` + `stat`.

---

#### F4 — persist redacted action results

**Where:**

- Type: `packages/dual-workflow-engine/src/types.ts:259-298` (`ActionRedactor`, `saveActionFinalize`)
- DB: `packages/dual-workflow-engine/src/persistence.ts:177-194` (`_redactor` unused, `JSON.stringify(result)`)
- Memory: same file `:355-368`
- Caller: `packages/dual-workflow-engine/src/action-step.ts:88-96` (does not pass a redactor)
- Producer: `packages/dual-workflow-engine/src/host.ts:172-174` (`data: { stdout, stderr, exitCode }`)

**Fix:**

1. `saveActionFinalize` **uses** `redactor`. If `result` is an object with a `data` record and a redactor is provided, persist `redactor(kind, result.data)` inside a shallow copy; if no kind is on the result, pass `kind` from the row or change the signature to `redactor(kind, result)`.
2. Simplest contract that matches the existing type (`ActionRedactor = (kind, options) => Record<string, unknown>`):

   - Change persist to: `const persisted = result === undefined ? null : JSON.stringify(applyRedactor(redactor, kind, result))`.
   - `applyRedactor`: if no redactor, apply `defaultActionRedactor`. If redactor, call it with `(kind, asRecord(result))`.
3. `defaultActionRedactor(kind, payload)`: for `kind === 'shell'`, replace `data.stdout` / `data.stderr` with `'[redacted]'` (or omit them). Leave `exitCode` / `ok`. Other kinds: pass through (or strip string fields longer than N).
4. `runActionStep` must pass the redactor: add `redactor?: ActionRedactor` to `ActionStepDeps` / `WorkflowRunOptions` if missing; default `defaultActionRedactor`. Thread `action.kind`.
5. Allow opt-in `persistActionOutput: true` on run options **only if** you need raw stdout for a debugger — default off. If you add this flag, document it; otherwise always redact shell streams.

**Do not** persist the resolved shell `command` line (already ignored at `saveActionStart` — keep that).

**Tests:** persist a shell result with `stdout: 'sk-abc…'` and assert `result_json` does not contain `sk-abc`. Assert a custom redactor is invoked.

---

#### F5 — unify `env` merge

**Where:** `packages/runtime/src/process-executor.ts:363` (`Bun.spawn` env) vs `:666` (execa, extend by default). Test: `packages/runtime/tests/process-executor.test.ts:262-286`.

**Fix:** When `options.env` is set for `runStreaming`, merge:

```ts
const childEnv = options.envMode === 'replace'
  ? options.env
  : { ...getProcessEnv(), ...options.env };
```

`getProcessEnv` is already the sanctioned accessor (`packages/runtime/src/config.ts:93-95`). Add `envMode?: 'merge' | 'replace'` to `ProcessOptions` **and** `PipeProcessOptions` (or a shared base). Default `'merge'`.

Filter `undefined` values if you spread `getProcessEnv()` (`Record<string, string | undefined>`) into Bun’s `env` (string-only).

**Do not** change execa’s default. **Do** add the `runStreaming` sentinel test cloned from 0056 (use `sh -c 'echo SENTINEL=…'`).

**CHANGELOG:** `Fixed` — `runStreaming({ env })` no longer replaces the parent environment. Mention `envMode: 'replace'` for the old behaviour.

---

#### F6 — atomic reseed + keep vars

**Where:** `packages/dual-workflow-engine/src/persistence.ts:244-254` (DB) and `:431-435` (memory). Resume: `packages/dual-workflow-engine/src/service.ts:168-173`. `commitTransition` already exists (`persistence.ts:87-106`). Snapshot load: `loadLatestStateSnapshot` (`:270-285`).

**Fix:**

```ts
async reseedRun(runId: string, newState: string): Promise<WorkflowReseedResult> {
  await this.ensureSchema();
  const previous = await this.loadLatestStateSnapshot(runId);
  const now = Date.now();
  const data = {
    ...(previous?.data ?? {}),
    reseeded: true,
    reseededAt: new Date(now).toISOString(),
  };
  const from = previous?.state ?? '';
  await this.commitTransition(runId, from, newState, '__reseed__', newState, data);
  return { fromState: previous?.state ?? null, toState: newState };
}
```

Same for the memory adapter (sequential is OK there per ADR-020 memory semantics, but still one method so the split-write path is gone).

**Tests:** snapshot with `effectiveVars: { __hitlAnswer: 'yes' }` → reseed → `loadLatestStateSnapshot` still has that key. Grep the implementation: `reseedRun` must not call `saveWorkflowState` + `saveTransition` as two statements.

---

#### F7 — unsupported cron throws

**Where:** `packages/infra/src/scheduler/node.ts:16-40`. 0032 added the warn; the 60s fallback remains.

**Fix:** After the three supported branches, `throw new RangeError(\`Unsupported cron expression: ${cron}\`)`. Do not `return 60_000`. `register()` should throw before `startEntry`. If an entry was already stored from a previous version’s behaviour, `start()` must not start a timer for an unparsable cron (throw at register time so `start` stays simple).

**Supported (keep):**

- non-empty numeric string `> 0` → that many ms
- 5-field `* * * * *` → 60_000
- 5-field `*/N * * * *` with `N > 0` → `N * 60_000`

**Tests:** `expect(() => new NodeSchedulerAdapter().register('0 3 * * *', action)).toThrow(RangeError)`. Existing interval tests stay green.

**CHANGELOG:** `Fixed` — unsupported cron no longer misfires every minute. This is a behaviour change for anyone who depended on the misfire; classify as **fix**, not `BREAKING`, matching 0032’s “warn documents it as unsupported” posture. Mention in the scheduler README.

**Do not** implement a real cron parser.

---

#### F8 — per-adapter table ensure

**Where:** `packages/llm-jsonl-importer/src/jsonl-importer-dao.ts:160-206` (`const _ensuredTables = new Set<string>()`).

**Fix (pick one, prefer A):**

- **A (recommended):** delete `_ensuredTables`. `CREATE TABLE IF NOT EXISTS` is already idempotent (`ETL_TABLE_DDL`). Typed tables already skip CREATE.
- **B:** `WeakMap<ImportOptions['db'], Set<string>>` keyed by the adapter object.

**Test:** two temp sqlite adapters; custom `targetTable: 'history_etl_custom'` (valid `VALID_TABLE_NAME`); import one row on A; import one row on B without sharing process cache — B must not throw `no such table`.

---

#### F9 — batched ledger lookup + atomic record/ledger write

**Where:** `packages/llm-jsonl-importer/src/importer.ts:133-180`; DAO `insertRecord` / `insertLedger` / `ledgerExists`. OpenCode path already batches (`openCodeBulkWriteOperations`) — copy that shape.

**Fix:**

1. After the first pass builds `prepared[]` for a line (or a file chunk), collect hashes, `SELECT record_hash FROM history_import_ledger WHERE record_hash IN (${placeholders})` in chunks of 200.
2. For hashes not present, build `DbBatchOp[]` for `insertRecord` SQL + `insertLedger` SQL and `await db.batch(ops)` (plus checkpoint write for that line).
3. Extract the INSERT SQL builders from `insertRecord` / `insertLedger` so batch and single-write cannot drift (same pattern as `transitionRow` / `stateRow` in workflow persistence).

**Do not** require a temp-table reconcile in this task. `desiredHashes` Set stays for full-mode reconcile unless it is trivial to reuse the chunked IN query. Document residual memory in Solution if the Set remains.

**Test:** spy/`db.batch` call count ≥ 1 for a 3-record import; a fake adapter that throws on the second sequential `run` after a successful first `run` must **not** be the import path anymore (import uses `batch`).

---

#### F10 — paged `drainPending`

**Where:** `packages/db/src/inbox-message-dao.ts:121-138`. Port: `packages/ai-runner/src/message-store.ts:26-31`. Orchestrator flush: `packages/ai-runner/src/team-orchestrator.ts` (`injectPendingMessages` / `flushInbox`).

**Fix:**

```ts
async drainPending(toId: string, options?: { limit?: number }): Promise<InboxMessage[]>
```

Default `limit = 100`. Add `LIMIT ${limit}` to the subquery (parameterize if the dialect allows; drizzle `sql` fragment). Validate `limit` is a positive integer.

`MessageStore.drainPending` gets the same optional second arg. `TeamOrchestrator.flushInbox` loops:

```ts
for (;;) {
  const batch = await this.inbox.drainPending(toId);
  if (batch.length === 0) break;
  // inject each …
  if (batch.length < 100) break;
}
```

**Test:** enqueue 150, first drain returns 100, second returns 50. Existing tests that assume “all rows” must loop or pass `{ limit: 10_000 }`.

---

#### C1 — drop `D1Adapter` from the main barrel

**Where:** `packages/db/src/index.ts:2` `export { D1Adapter } from './adapters/d1'`. Class: `packages/db/src/adapters/d1.ts:1` value-imports `drizzle-orm/d1`. Subpath `./d1` already exists (`package.json` exports). Factory already dynamic-imports (`adapter.ts:97-100`).

**ADR:** addendum to **ADR-005** (not a new ADR): main barrel must not statically import adapter implementations; `D1Adapter` lives on `@gobing-ai/ts-db/d1` only.

**Fix:** remove the value export from `index.ts`. Keep `export type { … InternalDb }` if it is type-only (it already is). Update `packages/db/README.md` and `docs/design/package-exports.md` if they show `import { D1Adapter } from '@gobing-ai/ts-db'`.

**BREAKING CHANGE** footer on the commit if any in-repo importer uses the barrel path — grep first. In-repo `createDbAdapter` callers do not need `D1Adapter`.

**Test:** a unit test that reads `packages/db/src/index.ts` (or the built `dist/index.js`) and asserts it does not contain `adapters/d1` as a static import. Typecheck of a snippet `import { createDbAdapter } from '@gobing-ai/ts-db'` still works.

---

#### C2 — stop the extension path smash

**Where:**

- Shared: `packages/runtime/src/extension/extension-loader.ts:14-23,97-128`
- Rule-engine: `packages/rule-engine/src/config/extensions.ts:68-79` (collects **abs** paths), `:110-136` (smash)
- Workflow: `packages/dual-workflow-engine/src/extensions.ts:82-105` (same smash)

**Fix (option a — recommended):** change collect-time to keep the **authored relative string** + `sourceDir` as `baseDir`. `collectExtensions` already has `sourceDir` and the authored `path`. Stop calling `resolvePath(sourceDir, path)` as the stored ref. Map 1:1 onto `ExtensionRef { path, baseDir: sourceDir, kind, sourceName }`. Delete the smash + the duplicated `..` pre-check (the shared loader already calls `assertRelativeExtensionPath`).

Workflow: same — store authored relative path + declaring dir, not absPath.

**Keep** ADR-022 `realPath` default on the rule-engine real import path (`extensions.ts:144-145`).

**Tests:** existing traversal tests must still fail on `../secret.ts`. Add a test that the shared loader is invoked with `path` containing a directory prefix (`./exts/foo.ts`), not only `./foo.ts`.

**Do not** add a third path API on the loader.

---

#### SHOULD / MAY (short)

- **R13** `packages/llm-jsonl-importer/src/redaction.ts:4-19` — add patterns `\bxai-[A-Za-z0-9_-]{12,}\b`, `\bAKIA[0-9A-Z]{16}\b`, `\bBearer\s+[A-Za-z0-9._\-=]+\b`. Tests in `hash-redaction.test.ts` / `redaction.test.ts`.
- **R14** `packages/ai-runner/src/agents/auth-shims.ts:138-145` — parse JSON; authenticated only if a known credential field is a non-empty string (or nested `tokens.access_token`). Otherwise `unknown` (missing file) or `unauthenticated` (file exists, no creds).
- **R15** `packages/rule-engine/src/evaluators/file-discovery.ts:97-106` — skip files with `stat.size > 2_000_000` (constant, documented). Evaluators still see smaller files unchanged.
- **R16** move `history_etl_*` CREATE out of `schema-sql.ts` into `ensureTargetTables` only.
- **R17** async `getGitContext(workspace, executor?: ProcessExecutor)`; deprecate the sync default. Update in-tree callers.

**ADRs to touch**

| Item | ADR action |
|------|------------|
| C1 | ADR-005 addendum — main barrel must not statically export adapter classes |
| F6 | none (use ADR-020 `commitTransition`) |
| F3 | none (walkDir behaviour; no contract rename) |
| F5 | none; CHANGELOG Fixed + TSDoc on `env` / `envMode` |
| F7 | none; CHANGELOG Fixed |
| C2 | none (align with ADR-010/022; do not supersede) |
| R17 if shipped | note under ADR-023 A2 follow-up |

**SECUA / architecture calibration:** patterns already blessed (EventBus inject, plugin host, schema subpath, `workspace:*`) are not drift. Do not “fix” sanctioned `node:*` in `application-node.ts` or `process-executor.ts`.
### Plan
Work as one WBS. Commit per package group (conventional `fix:` / `docs:`). Do not commit secrets. Run the listed tests after each step before moving on.

1. **Read** this task’s Design + the cited `file:line` anchors. Re-read before editing — do not implement from memory. Check `.wolf/cerebrum.md` / `.spur/context/pitfalls.md` if present.

2. **F1 `ts-utils`**
   - Patch `packages/utils/src/object.ts` `deFlattenKeys`.
   - Add the `__proto__.polluted` + `constructor.prototype` regression in `packages/utils/tests/object.test.ts`.
   - `bun test packages/utils/tests/object.test.ts`.

3. **F2 `ts-runtime` remote schema**
   - Patch `readSchema` in `packages/runtime/src/schema-validation.ts`.
   - Flip `packages/runtime/tests/schema-validation.test.ts:77` (fetch-alone must throw). Add the dual-gate matrix (none / allowRemote-only / fetch-only / both).
   - Update `packages/runtime/README.md` remote-schema table (delete “built-in fetch”).
   - `bun test packages/runtime/tests/schema-validation.test.ts`.

4. **F3 `ts-runtime` walkDir**
   - Patch `packages/runtime/src/fs.ts` with visited-realpath + start-root confinement.
   - Tests in `packages/runtime/tests/fs.test.ts` (cycle, escape, in-root symlink).
   - `bun test packages/runtime/tests/fs.test.ts`.

5. **F5 `ts-runtime` env merge**
   - Patch `runStreaming` in `packages/runtime/src/process-executor.ts`; add `envMode` on the shared options type.
   - Clone the 0056 sentinel test for `runStreaming`.
   - CHANGELOG + TSDoc.
   - `bun test packages/runtime/tests/process-executor.test.ts`.

6. **F4 + F6 `ts-dual-workflow-engine`**
   - Implement default shell redactor; wire `saveActionFinalize` + `runActionStep`.
   - Rewrite both `reseedRun` implementations to `commitTransition` + preserve `effectiveVars`.
   - Tests: redacted `result_json`; reseed keeps `__hitlAnswer`; no split-write.
   - `bun test packages/dual-workflow-engine/tests/`.

7. **F7 `ts-infra` cron**
   - Throw `RangeError` from `parseInterval` / `register` on unsupported expressions.
   - Update scheduler tests + README.
   - `bun test packages/infra/tests/scheduler-node.test.ts`.

8. **F8 + F9 `ts-llm-jsonl-importer`**
   - Remove or per-adapter `_ensuredTables`.
   - Extract INSERT builders; chunked ledger lookup; `db.batch` for record+ledger.
   - Tests: two-db custom table; batch path used; existing importer/forensic tests still pass.
   - `bun test packages/llm-jsonl-importer/tests/`.

9. **F10 `ts-db` + `ts-ai-runner`**
   - `drainPending(toId, { limit })` default 100; loop in `TeamOrchestrator`.
   - Update `MessageStore`.
   - Tests: 150-row page; orchestrator still drains all.
   - `bun test packages/db/tests/inbox-message-dao.test.ts packages/ai-runner/tests/team-orchestrator.test.ts`.

10. **C1 `ts-db` barrel**
    - ADR-005 addendum in `docs/00_ADR.md`.
    - Remove `export { D1Adapter }` from `packages/db/src/index.ts`.
    - Update README / `docs/design/package-exports.md`.
    - Grep in-repo `D1Adapter` imports; retarget to `/d1` if any.
    - `bun test packages/db/tests/index.test.ts` (or add the barrel static-import assertion).

11. **C2 extension smash**
    - Change collect → authored relative + `baseDir`.
    - Delete smash blocks in rule-engine and dual-workflow-engine.
    - Keep ADR-022 `realPath` defaults.
    - `bun test packages/rule-engine/tests/config/extensions.test.ts packages/dual-workflow-engine/tests/extensions.test.ts` (and any host/loader tests).

12. **SHOULD R13–R15**
    - Redaction patterns + tests.
    - Gemini settings parse.
    - `scanFiles` size cap.

13. **MAY R16–R17** — implement or write a one-paragraph deferral in Solution with a follow-up title (do not silently drop).

14. **Docs + gate**
    - CHANGELOG entries for user-visible fixes.
    - `bun run format` if you touched formatting.
    - `bun run spur-check` then `bun run build`.
    - Fill Solution with `file:line` for every changed file (L3). Fill Testing with the per-requirement table. Fill Review disposition (FIXED / DEFERRED).

15. **Stop.** Do not take drive-by refactors. If a MUST item is blocked, mark it UNMET in Testing and stop — do not `.skip` tests to go green.
### Solution
**Implemented 2026-08-12 (task 0060).** All 12 MUST items + R13–R15 shipped; R16/R17 deferred with follow-ups. Deferrals recorded below.

**Edits**

| File | Package | Change |
|------|---------|--------|
| `packages/utils/src/object.ts:58` | ts-utils | `deFlattenKeys` skips `__proto__`/`constructor`/`prototype` segments (R1) |
| `packages/utils/tests/object.test.ts:64` | ts-utils | `__proto__.polluted` + `constructor.prototype` regression |
| `packages/runtime/src/schema-validation.ts:346` | ts-runtime | Dual-gate `allowRemote` + `fetch` in `readSchema` (R2); `parseJsonContent` helper at :88 |
| `packages/runtime/tests/schema-validation.test.ts:59` | ts-runtime | Dual-gate matrix incl. fetch-alone rejection |
| `packages/runtime/README.md:264` | ts-runtime | Remote-schema docs — no phantom built-in fetch |
| `packages/runtime/src/fs.ts:51` | ts-runtime | `walkDir` visited-realpath + start-root confinement (R3); `readJsonFile` try/catch |
| `packages/runtime/tests/fs.test.ts:110` | ts-runtime | Cycle / escape / in-root symlink tests |
| `packages/runtime/src/process-executor.ts:183,363` | ts-runtime | `envMode` merge default; `resolveChildEnv` (R5) |
| `packages/runtime/tests/process-executor.test.ts:290` | ts-runtime | `runStreaming` merge + replace sentinel tests |
| `packages/dual-workflow-engine/src/persistence.ts:177,244,355,20` | dual-workflow | `applyRedactor`/`defaultActionRedactor`; both `reseedRun` via `commitTransition` (R4/R6) |
| `packages/dual-workflow-engine/src/action-step.ts:88` | dual-workflow | Pass `action.kind` + `options.redactor ?? default` to `saveActionFinalize` |
| `packages/dual-workflow-engine/src/types.ts:185,299` | dual-workflow | `WorkflowRunOptions.redactor`; `saveActionFinalize` kind param |
| `packages/dual-workflow-engine/tests/persistence.test.ts:110,191,265` | dual-workflow | Redaction + atomic-reseed regressions |
| `packages/infra/src/scheduler/node.ts:15,75` | ts-infra | `parseInterval` throws `RangeError`; `register` validates (R7) |
| `packages/infra/tests/scheduler/node.test.ts:95` | ts-infra | Unsupported-cron throws; supported cadences schedule |
| `packages/infra/README.md:316` | ts-infra | Cron support matrix documented |
| `packages/llm-jsonl-importer/src/jsonl-importer-dao.ts:160,177,214,232,251` | importer | Removed `_ensuredTables`; `recordInsertOp`/`ledgerInsertOp`/`checkpointUpsertOp`/`ledgerExistingHashes` (R8/R9) |
| `packages/llm-jsonl-importer/src/importer.ts:133` | importer | Chunked ledger lookup (≤200) + per-line `db.batch` incl. checkpoint |
| `packages/llm-jsonl-importer/tests/jsonl-importer-dao.test.ts:107,146` | importer | Per-adapter custom table test |
| `packages/llm-jsonl-importer/tests/importer.test.ts:84,104` | importer | Batch-path test; mid-batch recovery test |
| `packages/db/src/inbox-message-dao.ts:121` | ts-db | `drainPending(toId, { limit = 100 })` paged claim (R10) |
| `packages/db/tests/inbox-message-dao.test.ts:57` | ts-db | 150-row paging + limit validation |
| `packages/ai-runner/src/message-store.ts:28` | ts-ai-runner | `drainPending` options param |
| `packages/ai-runner/src/team-orchestrator.ts:158` | ts-ai-runner | Drain loop until short page |
| `packages/db/src/index.ts:2` | ts-db | Dropped `D1Adapter` value export (R11) |
| `packages/db/tests/index.test.ts:9` | ts-db | Barrel no longer exports D1Adapter; no static `adapters/d1` import |
| `docs/00_ADR.md:69` | docs | ADR-005 addendum — barrel must not statically export adapter classes |
| `packages/rule-engine/src/config/extensions.ts:19,70,110` | rule-engine | `ExtensionRef` = authored `path` + `baseDir`; no smash (R12) |
| `packages/rule-engine/tests/config/extensions.test.ts` | rule-engine | Authored-path assertions |
| `packages/dual-workflow-engine/src/extensions.ts:30,90` | dual-workflow | Same ref-shape change; no smash |
| `packages/dual-workflow-engine/tests/extensions.test.ts:435` | dual-workflow | Traversal moved into authored `path` |
| `packages/llm-jsonl-importer/src/redaction.ts:18` | importer | `xai-` / `AKIA` / `Bearer` patterns (R13) |
| `packages/ai-runner/src/agents/auth-shims.ts:137` | ts-ai-runner | Credential-shape Gemini auth (R14) |
| `packages/rule-engine/src/evaluators/file-discovery.ts:59,105` | rule-engine | `MAX_SCANNED_FILE_BYTES` 2 MiB skip (R15) |
| `CHANGELOG.md` | docs | Unreleased: F1/F2/F5/F7 Fixed, F3/F4 Security, C1/C2 Breaking |

**Deferrals (MAY — follow-up tasks to be spawned, WBS not yet assigned; 0061 is a separate meta task)**

- **R16** (importer ETL DDL owner): static `HISTORY_IMPORT_SCHEMA_SQL` still owns the built-in `history_etl_*` CREATEs; moving all `history_etl_*` DDL to `ensureTargetTables`/`ETL_TABLE_DDL` is a DDL-ownership refactor with its own review surface. Follow-up: *importer ETL DDL single-owner (R16)*.
- **R17** (async `getGitContext` default): making `getGitContext` async and defaulting to `ProcessExecutor` over `new BunSyncProcessExecutor()` is a breaking API change with in-tree + external caller updates. Follow-up: *getGitContext async ProcessExecutor default (R17, ADR-023 A2)*.

**No new dependencies; no ADR superseded (ADR-005 addendum only).**
### Testing
All gates run 2026-08-12 after implementation. `bun run spur-check` exit 0 (1945 tests, 0 fail, both rule presets `--fail-on warning` clean); `bun run build` exit 0 for all 8 packages. No skipped tests; no `biome-ignore` added.

**Per-Requirement Traceability**

| Req | Status | Evidence |
| --- | --- | --- |
| R1 | MET | `bun test packages/utils/tests/object.test.ts` — `deFlattenKeys does not pollute Object.prototype via __proto__ / constructor segments` |
| R2 | MET | `bun test packages/runtime/tests/schema-validation.test.ts` — dual-gate matrix (none / allowRemote-only / fetch-only all throw; both succeed) |
| R3 | MET | `bun test packages/runtime/tests/fs.test.ts` — cycle, escape, in-root symlink tests |
| R4 | MET | `bun test packages/dual-workflow-engine/tests/persistence.test.ts` — redacts shell stdout/stderr; custom redactor invoked |
| R5 | MET | `bun test packages/runtime/tests/process-executor.test.ts` — runStreaming merge + envMode replace sentinel tests |
| R6 | MET | `bun test packages/dual-workflow-engine/tests/persistence.test.ts` — reseed preserves `effectiveVars.__hitlAnswer`, single `db.batch` (spied) |
| R7 | MET | `bun test packages/infra/tests/scheduler/node.test.ts` — `0 3 * * *` throws RangeError; `* * * * *` / `*/5 * * * *` / `60000` schedule |
| R8 | MET | `bun test packages/llm-jsonl-importer/tests/jsonl-importer-dao.test.ts` — custom table created per adapter across two DBs |
| R9 | MET | `bun test packages/llm-jsonl-importer/tests/importer.test.ts` — record+ledger+checkpoint through `db.batch` (no `run()` insert seam); mid-batch failure recovery |
| R10 | MET | `bun test packages/db/tests/inbox-message-dao.test.ts` — 150 rows drain 100 + 50; limit validation; orchestrator loop drains fully (ai-runner suite) |
| R11 | MET | `bun test packages/db/tests/index.test.ts` — barrel has no D1Adapter; no static `adapters/d1` import; factory path unchanged |
| R12 | MET | `bun test packages/rule-engine/tests/config/extensions.test.ts packages/dual-workflow-engine/tests/extensions.test.ts` — authored `./exts/...` preserved; `..` in path rejected; realPath confinement tests still pass |
| R13 | MET | `bun test packages/llm-jsonl-importer/tests/redaction.test.ts` — xai-/AKIA/Bearer replaced; sk-/assignment/email still match |
| R14 | MET | `bun test packages/ai-runner/tests/agents/auth-shims.test.ts` — empty apiKey / UI banner / bare token → unauthenticated; apiKey / tokens.access_token → authenticated |
| R15 | MET | `bun test packages/rule-engine/tests/evaluators/file-discovery.test.ts` — >2 MiB file skipped, small file unchanged |
| R16 | DEFERRED | N/A — follow-up *importer ETL DDL single-owner (R16)* (WBS to assign) |
| R17 | DEFERRED | N/A — follow-up *getGitContext async ProcessExecutor default (R17)* (WBS to assign) |
| R18 | MET | `bun run spur-check` exit 0; `bun run build` exit 0; CHANGELOG + ADR-005 addendum for public-contract changes |

**Acceptance Criteria Verification**

| AC | Status | Evidence |
| --- | --- | --- |
| R1 — no Object.prototype pollution | MET | regression test in `packages/utils/tests/object.test.ts` |
| R2 — remote fetch dual-gated | MET | flipped fetch-alone test + matrix in `schema-validation.test.ts` |
| R3 — walkDir cycle-safe & confined | MET | 3 new fs tests |
| R4 — shell results redacted | MET | `result_json` contains `[redacted]`, not `sk-abc`; custom redactor spy |
| R5 — run/runStreaming env merge | MET | merge + replace sentinel tests via `sh -c` |
| R6 — atomic reseed keeps vars | MET | batch spy + `effectiveVars.__hitlAnswer` survives |
| R7 — unsupported cron throws | MET | RangeError at register; supported cadences intact |
| R8 — per-adapter table ensure | MET | two-adapter custom-table test |
| R9 — chunked lookup + batch write | MET | batch-call spy; ≤200 IN chunks; mid-batch crash test |
| R10 — paged drain | MET | 100/50 paging + orchestrator drain loop |
| R11 — no D1Adapter in barrel | MET | `'D1Adapter' in db === false` + source static-import guard |
| R12 — authored paths to shared loader | MET | ref.path/baseDir assertions end-to-end |
| R16 | DEFERRED | follow-up named, WBS to assign |
| R17 | DEFERRED | follow-up named, WBS to assign |
| R18 — gates | MET | spur-check + build exit 0 |

**Commands (all exit 0):**

```bash
bun test packages/utils/tests/object.test.ts
bun test packages/runtime/tests/schema-validation.test.ts packages/runtime/tests/fs.test.ts packages/runtime/tests/process-executor.test.ts
bun test packages/dual-workflow-engine/tests/
bun test packages/infra/tests/scheduler/node.test.ts
bun test packages/llm-jsonl-importer/tests/
bun test packages/db/tests/inbox-message-dao.test.ts packages/ai-runner/tests/team-orchestrator.test.ts
bun run spur-check
bun run build
```
### Review
Source review: `/sp-dev-review packages --focus all` (2026-08-12). Path mode. Verdict: PARTIAL (0 blockers, 12 majors). All rows dispositioned below — implementer verdict as of 2026-08-12 post-implementation.

| Priority | Finding | File:Line | Disposition |
| --- | --- | --- | --- |
| P1 | No blocker-severity finding in this review | `docs/00_ADR.md:1` | N/A — none raised |
| P2 | F1 `deFlattenKeys` prototype-pollutes on `__proto__.*` | `packages/utils/src/object.ts:58` | FIXED — R1 (skip guard + regression) |
| P2 | F2 documented `allowRemote` SSRF gate is never read | `packages/runtime/src/schema-validation.ts:346` | FIXED — R2 (dual gate + README) |
| P2 | F3 `walkDir` follows symlink cycles / can escape start root | `packages/runtime/src/fs.ts:51` | FIXED — R3 (visited-realpath + confinement) |
| P2 | F4 `ActionRedactor` unused; shell stdout persisted raw | `packages/dual-workflow-engine/src/persistence.ts:177` | FIXED — R4 (default + caller redactor) |
| P2 | F5 `runStreaming` replaces env; `run()` merges | `packages/runtime/src/process-executor.ts:363` | FIXED — R5 (envMode merge default) |
| P2 | F6 `reseedRun` not atomic and wipes `effectiveVars` | `packages/dual-workflow-engine/src/persistence.ts:252` | FIXED — R6 (commitTransition + var merge) |
| P2 | F7 unsupported cron still fires every 60s | `packages/infra/src/scheduler/node.ts:37` | FIXED — R7 (RangeError at register) |
| P2 | F8 `_ensuredTables` is process-global | `packages/llm-jsonl-importer/src/jsonl-importer-dao.ts:160` | FIXED — R8 (idempotent per-adapter DDL) |
| P2 | F9 N+1 ledgerExists + non-atomic record/ledger writes | `packages/llm-jsonl-importer/src/importer.ts:133` | FIXED — R9 (chunked IN + db.batch) |
| P2 | F10 `drainPending` claims the entire inbox | `packages/db/src/inbox-message-dao.ts:121` | FIXED — R10 (paged default 100) |
| P2 | C1 main `ts-db` barrel value-exports `D1Adapter` | `packages/db/src/index.ts:2` | FIXED — R11 (ADR-005 addendum + subpath-only) |
| P2 | C2 both engines smash abs paths into the shared loader | `packages/rule-engine/src/config/extensions.ts:110` | FIXED — R12 (authored path + baseDir) |
| P3 | M1 redaction misses `xai-` / `AKIA` / `Bearer` | `packages/llm-jsonl-importer/src/redaction.ts:18` | FIXED — R13 |
| P3 | M2 Gemini auth is a loose `/auth\|token\|key/i` substring | `packages/ai-runner/src/agents/auth-shims.ts:137` | FIXED — R14 (credential-shape) |
| P3 | M3 `scanFiles` buffers every matching file body | `packages/rule-engine/src/evaluators/file-discovery.ts:59` | FIXED — R15 (2 MiB cap) |
| P4 | A1 importer table/DDL locality (0030 re-eval) | `packages/llm-jsonl-importer/src/schema-sql.ts:21` | DEFERRED — R16 → follow-up (WBS to assign) |
| P4 | A2 `BunSyncProcessExecutor` still git default (0030 / ADR-023 A2) | `packages/ai-runner/src/identity.ts:70` | DEFERRED — R17 → follow-up (WBS to assign) |

**Prior 0030:** `Bun.which` in identity.ts is still gone (not re-filed). Sync git default (R17) and importer table locality (R16) remain as P4 follow-ups (WBS to assign).
### References
- Review source: `/sp-dev-review packages --focus all` (2026-08-12, path mode, `--agent` default inline)
- Prior related tasks: `0030` (packages review), `0032` (ts-infra SECU; cron warn added), `0041` (ADR-020/021/022), `0042`–`0045` (ADR-023 A1–A4), `0056` (`run()` env merge)
- ADRs: `docs/00_ADR.md` — ADR-005 (drizzle-free facade / this task adds barrel addendum), ADR-010/016/022 (extension loader), ADR-011/014 (platform + infra subpaths), ADR-013 (RunLifecycle), ADR-020 (`commitTransition` / `DbAdapter.batch`), ADR-021 (streaming importer), ADR-023 A2 (`ProcessExecutor` interface)
- Binding process: `docs/99_PROJECT_CONSTITUTION.md`, `AGENTS.md` verification gate
- Package READMEs to update if the contract you touch is documented there: `packages/runtime/README.md`, `packages/db/README.md`, `packages/infra/README.md`, `packages/dual-workflow-engine/README.md`, `packages/llm-jsonl-importer/README.md`
- Design index: `docs/design/package-exports.md` (C1)
- Evidence anchors (re-read before coding):
  - `packages/utils/src/object.ts:52-64`
  - `packages/runtime/src/schema-validation.ts:39,345-353`
  - `packages/runtime/src/fs.ts:51-66`
  - `packages/runtime/src/process-executor.ts:363,666`
  - `packages/dual-workflow-engine/src/persistence.ts:177-194,244-254`
  - `packages/dual-workflow-engine/src/action-step.ts:88-96`
  - `packages/dual-workflow-engine/src/host.ts:160-176`
  - `packages/dual-workflow-engine/src/service.ts:168-173`
  - `packages/infra/src/scheduler/node.ts:16-40`
  - `packages/llm-jsonl-importer/src/jsonl-importer-dao.ts:160-206`
  - `packages/llm-jsonl-importer/src/importer.ts:67-69,133-180`
  - `packages/db/src/inbox-message-dao.ts:121-138`
  - `packages/db/src/index.ts:1-2`
  - `packages/rule-engine/src/config/extensions.ts:110-136`
  - `packages/dual-workflow-engine/src/extensions.ts:82-105`
### History
- 2026-08-12T18:34:08.563Z backlog → todo (system)
- 2026-08-12T18:39:33.318Z todo → wip (system)
- 2026-08-12T19:08:30.498Z wip → testing (system)
### Notes
**For the next coding agent — read this first.**

You are implementing task **0060**, not re-reviewing `packages`. The review is done. Do not expand scope. Do not “improve architecture” beyond C1/C2.

**How to start**

```bash
spur task show 0060
# then re-read each Design file:line before the first edit
spur task update 0060 wip
```

**Hard rules (this repo)**

- `workspace:*` for internal deps. drizzle-orm only inside `ts-db`.
- No `node:fs` / `process.env` / `Bun.spawn` outside sanctioned seams.
- Tests live in `packages/<pkg>/tests/`, not under `src/`.
- Never skip a test to go green. Never `--no-verify`.
- Section writes only via `spur task update --section --from-file` (not raw edits to this task file).
- After implementation: fill Solution (`file:line`), Testing (MET + pasted command evidence), Review disposition FIXED/DEFERRED. Then `bun run spur-check` and `bun run build`.

**F3 pitfall:** skipping *all* directory symlinks will break LLM-history import when `$HOME/.claude` is a symlink. Use visited-realpath + start-root confinement.

**F2 pitfall:** `packages/runtime/tests/schema-validation.test.ts:77` currently *requires* fetch-alone to succeed. That test is wrong; flip it.

**F5 pitfall:** only `run()` has the 0056 merge test. `runStreaming` is the hole. `TeamAgentProcess` uses `runStreaming`.

**F6 pitfall:** resume depends on `effectiveVars` in the latest snapshot (`service.ts:168-173`). A reseed that writes `{ reseeded: true }` only drops HITL answers.

**C2 pitfall:** `basenamePath` makes `assertRelativeExtensionPath` a no-op. Delete the smash; do not add a third pre-check.

**Done means:** every MUST requirement is MET with test or command evidence in Testing, gates green, git status only intentional files.
