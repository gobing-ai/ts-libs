---
schema_version: 1
name: Fix 2026-09-23 packages SECUA and architecture review findings
status: done
template: standard
created_at: 2026-09-23T23:26:36.014Z
updated_at: "2026-09-24T03:10:09.748Z"

priority: P1
ac_numbering: task-local
ac_altitude: task-local
estimate_hours: 16
---

## 0086. Fix 2026-09-23 packages SECUA and architecture review findings

### Background

This task hands off the results of `/sp:dev-review packages --agent inline --focus all` (2026-09-23, path mode, inline). The review had two passes: SECUA via `sp:code-verification`, then architecture depth via `sp:code-improvement`. On review, `--fix` is a **deprecated no-op**, so this task is how the findings get fixed.

**Baseline at review time:** HEAD `d3e92081` (release 0.5.4). The tree was clean and `bun run spur-check` exited 0 with 2459 pass and 0 fail. So none of these defects is caught by the current suite. Every MUST item below needs a new regression test that fails on the unfixed source.

**Review verdict:** PARTIAL. There are 0 blockers, 6 majors (M1–M6), 9 minors (m1–m9), 3 architecture candidates (C1–C3) and 1 docs drift (D1).

**Evidence reproduced during review (not just inferred):**

- **M4 (redaction):** a probe script ran `redactValue` with `DEFAULT_REDACTION_RULES`.
  - These passed through **unredacted**:
    - `ghp_abcdefghijklmnopqrstuvwxyz0123456789`
    - `github_pat_11ABCDEFG0123456789_abcdefghijklmnop`
    - `sk_live_abcdefghijklmnop1234`
    - `{ password: 'hunter2hunter2', api_key: 'plainvalue123456' }`
  - Only `sk-ant-api03-…` (dash separator) was redacted.
- **M5 (fm argv):** tested live against `/usr/bin/fm` (macOS Foundation Models CLI, Swift ArgumentParser).
  - `fm count-tokens -q -i "be brief" "- item one"` exits 64 with `Error: Missing value for '-i <instructions>'`.
  - The same call with `--` before the prompt prints `61` and exits 0.
  - `-i "- bullet instr"` exits 64.
  - `"--instructions=- bullet instr" -- "hello"` prints `60` and exits 0.
- **M1 (shell injection):** confirmed by reading the code path end to end. `variables.ts:52` `resolveTemplateString` does raw substitution, `action-step.ts:75` resolves the templates, and `host.ts:164` runs them via `/bin/sh -c`. Values from `setVars` produced by earlier actions reach the template through `mergeSetVars` (`variables.ts:23`). There is no quoting layer in between.

**Areas reviewed and found clean (do not touch):**

- `runtime/src/extension/extension-loader.ts` path confinement.
- `llm-jsonl-importer` SQL identifier validation (`targetTableFor` + `VALID_TABLE_NAME`).
- `db/src/ddl.ts` `quoteIdent`.
- The rule-engine ripgrep evaluator (already passes `--`).
- Cursor parsing in `ts-utils`.
- `ai-runner/src/agent-spec.ts` `validateAgentId`.

**Why one task:** the operator asked for a single, implementation-ready task. The findings span 8 packages: dual-workflow-engine, infra, db, decision-fm, ai-runner, llm-jsonl-importer, runtime and rule-engine. Two items change the public or persistence contract:

- M6 extends `WorkflowPersistenceAdapter.finalizeRun`.
- M3 changes the attempts accounting for reclaimed jobs.

One implementer, or a sequenced `/sp:dev-run`, needs a frozen, evidence-backed change map, not a second review. Each Design subsection names the exact `file:line`, the current code, the target shape and the test to add.

**Severity legend used below:**

- M = major. Correctness or security; MUST fix.
- m = minor. MUST fix unless marked MAY.
- C = architecture candidate. C1 MUST, because M1 depends on it; C2/C3 MAY.
- D = docs drift. MUST.

### Requirements

Implement in Plan order. Never skip a MUST item to polish a MAY item. Finding IDs (M/m/C/D) come from the Background and are cross-referenced in Design.

- [x] R1. Process gate. Contract changes must first get an entry under `CHANGELOG.md` `## [Unreleased]` → `### Fixed` (create the heading if absent; `bump-ver` folds it into the release section per `docs/PACKAGE_RELEASE.md:38`): M3 attempts accounting, M6 `finalizeRun` fencing, M1 shell substitution semantics and R11's new `timeout` action option. A pure bugfix gets no new ADR number. M6 gets a dated addendum to ADR-025 (Run Interruption Contract, `docs/00_ADR.md:403`), because it extends the `owner_attempt` fencing that ADR introduced. `bun run spur-check` and `bun run build` must both exit 0. No `.skip`, no `biome-ignore` added to silence the gate, no `--no-verify`. Every MUST item gets at least one new or extended regression test that fails against the unfixed source. Package READMEs that document a changed contract are updated in the same commit. Internal deps stay `workspace:*` (ADR-002). drizzle-orm stays inside `ts-db` (ADR-005). Platform APIs stay behind ts-runtime seams (ADR-011/014).

- [x] R2. (C1) `ShellActionRunner.execute` and `ShellGuardRunner.evaluate` in `packages/dual-workflow-engine/src/host.ts` share one private module-level helper. It owns option parsing (`command`, `args`, `cwd`, and `timeout` from R11), choosing between shell and argv form, and the `processExecutor.run` call. Both runners keep their public result shapes: `ActionResult` with `data.{stdout,stderr,exitCode}`, and `GuardEvaluationResult` with `report.{stdout,stderr,exitCode}`. All existing `host.test.ts` tests pass unchanged.

- [x] R3. (M1) Values substituted into a **shell-form** command (`command` with no `args`) must not be interpreted as shell syntax. This covers workflow vars, `setVars` from earlier actions, env refs and builtins. Each `${…}` ref in a shell-form `command` is bound to a generated environment variable (`__WF_0`, `__WF_1`, …), and the command text references it as `${__WF_n}`. The shell expands values as parameter expansions and never re-parses them as commands. A var whose value is `x; touch <sentinel>` or `$(touch <sentinel>)` must never create the sentinel file, whether the ref is unquoted or inside double quotes. Inside double quotes, the value reaches the command as exactly one argument. Workflow authors can still use shell operators (`&&`, `|`, globs, quoting) in the literal template text. The persisted action-start options (`saveActionStart`) hold the rewritten command, not the resolved values. The explicit `args` (argv) form keeps raw substitution because argv is already injection-safe. A failed shell command's `error` string must not embed the resolved command text, which may contain `${env.X}` secrets. It reports the exit code, plus the unresolved template or the action kind.

- [x] R4. (M5) Every `fm` argv builder must tolerate a prompt and instructions that start with `-`. Instructions go as one `--instructions=<value>` token. The positional prompt comes right after a literal `--`. This covers `countTokensArgv` and `respondArgv` in `packages/decision-fm/src/fm-process.ts`, and the `fm` shim `getPromptCommand` in `packages/ai-runner/src/agents/shims.ts`. The existing argv-shape tests are updated to the new shape. New tests cover a `- item` prompt and `- bullet` instructions.

- [x] R5. (M4) `DEFAULT_REDACTION_RULES` in `packages/llm-jsonl-importer/src/redaction.ts` redacts GitHub classic tokens (`ghp_…`, plus `gho_`/`ghu_`/`ghs_`/`ghr_`), fine-grained `github_pat_…`, underscore-separated `sk_live_…`/`sk_test_…`/`pk_live_…`, and the existing dash forms. `redactValue` also redacts by **object key**: any string value whose key matches (case-insensitive) `api_key`/`apikey`/`api-key`, `token`, `access_token`, `refresh_token`, `secret`, `client_secret`, `password`, `passwd` or `authorization` becomes `[REDACTED:secret]`. All five reproduced samples from the Background must be redacted. Existing redaction tests stay green.

- [x] R6. (M2) `DbJobQueue.processOnce` in `packages/infra/src/job-queue/db-job-queue.ts` never holds a claimed row that no handler has started. Once claimed, a row starts `processJob` (and so lease renewal) at once. Setting `maxConcurrency < batchSize` must no longer let a waiting row's lease expire and let a rival consumer run it twice. After `stop()` is called, `processOnce` claims no further rows in the current cycle. Manual `processOnce()` drains on a consumer that was never `start()`ed must keep working.

- [x] R7. (M3) A job whose lease expires without the consumer settling it (worker crash/OOM/kill) counts that lost attempt. A leased `processing` row reclaimed by `QueueJobDao.claimReady` increments `attempts`. An expired-lease row whose `attempts + 1 >= max_retries` is moved to `failed` with a descriptive `error` instead of being reclaimed. A job that crashes every time therefore ends in `failed` after `maxRetries` reclaims instead of looping forever. The legacy token-less `resetStuckJobs` path follows the same accounting. Consumer-side `failOrRetry` math stays correct: each attempt is counted exactly once.

- [x] R8. (M6) `WorkflowPersistenceAdapter.finalizeRun` accepts an optional owner fence. When the caller knows its owner attempt id, the SQL adapter only updates the row if `owner_attempt` matches and `status = 'running'`. The memory adapter mirrors this. On a fence miss, `RunLifecycle` does not silently overwrite. It emits a stale-owner signal (a typed error or a `workflow.run.*` warning event, see Design) and leaves the new owner's state untouched. `RunLifecycle` knows its owner attempt on both start (the `proposed.owner_attempt`) and resume (the `ResumeOwnership` from `service.ts:184`). The interface change is additive: existing third-party adapters that ignore the new parameter still compile.

- [x] R9. (m1) `resolveLayaDriver` and `resolveFmDriver` in `packages/ai-runner/src/decision/decision-maker.ts` only map a **module-load failure** to `DecisionConfigError("… requires … to be installed")`. A missing factory export is still a `DecisionConfigError`, but its message names the missing export. An error thrown by `createLayaDriver(options)`/`createFmDriver(options)` propagates unchanged, e.g. a `DecisionConfigError` about a bad option or a missing fm binary.

- [x] R10. (m2) In `DbJobQueue`, the completed, failed and retrying metrics and events are only emitted when the matching DAO write returns `true`. Those writes are `markCompleted`, `markFailed` in `failOrRetry`, and `markForRetry`. This matches the existing cancel path (`db-job-queue.ts:348-349`). A fenced-out write (lost lease or stale token) emits nothing.

- [x] R11. (m3) Shell actions and guards accept an optional numeric `timeout` option in milliseconds, passed to `processExecutor.run({ timeout })`. A timed-out action returns `ok: false` with an error that says it timed out. A timed-out guard returns `passed: false`. A missing option keeps today's no-timeout behavior. A non-positive or non-finite value is a `WorkflowValidationError`.

- [x] R12. (m4) `probeFmAvailability` and `countPromptTokens` in `packages/decision-fm/src/fm-process.ts` run with a bounded timeout and map `outcome === 'timeout'` to `DecisionTimeoutError`. The probe defaults to 10 s. Token counting uses the driver's `requestTimeoutMs` or a 10 s default. The `runFmRespond` timeout message no longer embeds the full argv: it keeps the subcommand plus at most 200 chars of the rest, then `…`.

- [x] R13. (m5) `observeOutput` in `packages/runtime/src/process-executor.ts` uses one `TextDecoder` per stream with `{ stream: true }`. Multi-byte UTF-8 characters split across chunk boundaries are delivered intact to `onOutput`, and the decoder is flushed at stream end.

- [x] R14. (m6) The empty tracer span in `runStreaming` (`process-executor.ts:431`) is removed. Alternatively it is replaced by a span covering the real process lifetime, if the tracer API supports that without restructuring. The default is removal.

- [x] R15. (m7) The `fm` shim validates `sessionId` before using it as a file-name component. The id must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/` and must not contain `..`. An invalid id throws a `ValueError` that names the rejected value. A `sessionId` like `../../etc/x` never reaches `joinPath`.

- [x] R16. (m8) The rule-engine fixer's containment check (`isInsideWorkdir`, `packages/rule-engine/src/fixers/fixers.ts:159-162`) decides on path **segments**: a first segment of exactly `..`, not a `..` prefix. So a sibling like `..foo/file.ts` inside the workdir is accepted. When the injected `FileSystem` exposes `realPath` (ADR-022), both the workdir and the target's nearest existing ancestor are resolved through it before comparing. A symlink inside the workdir that points outside it is then rejected before `writeFile`/`deleteFile` (`fixers.ts:121-123`).

- [x] R17. (m9) `APIError` created from a non-OK response (`packages/infra/src/api-client.ts:308`) carries at most 4096 chars of the response body, suffixed `…[truncated N chars]` when cut. The timeout error message (`api-client.ts:253`) uses `observableUrl` instead of the raw `url`, so query-string secrets are not leaked into error messages.

- [x] R18. (C2, MAY) Migrate `getGitContext` in `packages/ai-runner/src/identity.ts:102` off the deprecated `BunSyncProcessExecutor` default. Record a removal plan for `BunSyncProcessExecutor`, `BunPipeProcessSpawner` and the `ProcessExecutor` value alias (`process-executor.ts:668-729`) in the runtime README. Implement it, or record a one-line deferral in Solution.

- [x] R19. (C3, MAY) Extract the process-group containment block (`process-executor.ts` ~771-929) into `packages/runtime/src/process-group.ts` with no behavior change. Implement it, or record a one-line deferral in Solution.

- [x] R20. (D1) Fix the docs drift. The `docs/03_ARCHITECTURE.md:116` heading says laya-mlx is "accepted design … not yet built", but the package exists and is published. The root `AGENTS.md` package table (read via the `CLAUDE.md` symlink) lacks the `ts-decision-fm` and `ts-laya-mlx` rows. Edits follow `docs/99_PROJECT_CONSTITUTION.md` (doc map and edit rules).

### Acceptance Criteria

Each scenario maps to one requirement via `(req: R<n>)`. Every scenario must be backed by an executable test or command named in Testing. R1 is a process gate and is verified by commands, not a scenario.

```gherkin
Feature: 2026-09-23 packages review findings are fixed

  Scenario: AC1 — Repository gates stay green after the fixes (req: R1)
    Given all MUST requirements are implemented
    When "bun run spur-check" and "bun run build" are run from the repo root
    Then both exit 0
    And "git diff" adds no ".skip(", no "biome-ignore" and no "--no-verify"
    And CHANGELOG.md has an "## [Unreleased]" "### Fixed" entry for M1, M3, M6 and the shell timeout option
    And docs/00_ADR.md has a dated ADR-025 addendum describing the finalizeRun owner fence

  Scenario: AC2 — Shell action and shell guard share one spawn helper (req: R2)
    Given packages/dual-workflow-engine/src/host.ts
    When ShellActionRunner.execute and ShellGuardRunner.evaluate are read
    Then both delegate to a single private helper for option parsing and processExecutor.run
    And every pre-existing test in packages/dual-workflow-engine/tests/host.test.ts passes unmodified

  Scenario: AC3 — Template values cannot inject shell code (req: R3)
    Given a state-machine workflow whose shell action command is "printf '%s' \"${vars.x}\" > out.txt; echo ${vars.x} >/dev/null"
    And the var x is "a; touch pwned-1" in one run and "$(touch pwned-2)" in another
    When the workflow runs with the built-in ShellActionRunner and a real NodeProcessExecutor in a temp dir
    Then neither "pwned-1" nor "pwned-2" exists in the temp dir
    And out.txt contains the var value byte-for-byte
    And a shell guard whose command references "${vars.x}" gets the same guarantee
    And a setVars value produced by an earlier action gets the same guarantee in a later action
    And the persisted action-start options contain "${__WF_0}" and not the var value

  Scenario: AC4 — Failed shell action does not leak resolved secrets in its error (req: R3)
    Given env SECRET_TOKEN="s3cr3t-value" and a shell action command "exit 3 # ${env.SECRET_TOKEN}"
    When the action runs
    Then the ActionResult has ok false and exitCode 3
    And the ActionResult error does not contain "s3cr3t-value"

  Scenario: AC5 — Argv form keeps raw substitution (req: R3)
    Given a shell action with command "printf" and args ["%s", "${vars.x}"] and x "a; b"
    When the action runs
    Then stdout is exactly "a; b"

  Scenario: AC6 — fm argv tolerates dash-leading prompt and instructions (req: R4)
    Given instructions "- bullet instr" and prompt "- item one"
    When countTokensArgv, respondArgv and the fm shim getPromptCommand build their argv
    Then instructions appear as the single token "--instructions=- bullet instr"
    And the token immediately before the prompt is "--"
    And the prompt is the last token
    And on a host with /usr/bin/fm, the live test "fm count-tokens -q --instructions=- bullet instr -- - item one" exits 0 (skip only when fm is absent, following the existing live.test.ts gating)

  Scenario: AC7 — Default redaction covers GitHub, underscore Stripe-style keys and secret-named keys (req: R5)
    Given the strings "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop" and "sk_live_abcdefghijklmnop1234"
    And the object { password: "hunter2hunter2", api_key: "plainvalue123456", nested: { Authorization: "xyz123" } }
    When redactValue is applied with DEFAULT_REDACTION_RULES
    Then none of the raw secret values appear in the output
    And the object values become "[REDACTED:secret]"
    And a non-secret key such as "tokens_used" with a number value is unchanged
    And the existing "sk-ant-api03-…" and email redaction tests still pass

  Scenario: AC8 — Waiting batch rows are never left with an expiring lease (req: R6)
    Given a DbJobQueue with batchSize 2, maxConcurrency 1 and visibilityTimeout 150ms on a real SQLite QueueJobDao
    And two pending jobs, where the handler for the first sleeps 400ms
    When processOnce runs on consumer A while consumer B polls every 50ms
    Then each job's handler runs exactly once in total
    And consumer B never claims the second job while consumer A still owns the cycle

  Scenario: AC9 — stop() halts further claims within a cycle (req: R6)
    Given a started DbJobQueue with batchSize 4, maxConcurrency 1 and four pending jobs
    When stop() is called while the first job's handler is running
    Then no further jobs move to processing after the first settles
    And the remaining jobs stay pending with no attempt token
    And processOnce on a never-started consumer still drains all four jobs

  Scenario: AC10 — Crash-looping jobs end in failed (req: R7)
    Given a leased job with maxRetries 3
    When its lease expires unsettled three times in a row (simulated by advancing the DAO clock past leaseExpiresAt without settling)
    Then attempts increments on each reclaim
    And after the third expiry claimReady does not return the job
    And the job status is "failed" with an error mentioning lease expiry and exhausted attempts
    And a job that fails normally through the handler still ends failed after exactly maxRetries total attempts

  Scenario: AC11 — Stale owner cannot finalize over the new owner (req: R8)
    Given a durable run owned by attempt A that is interrupted and then resumed by attempt B
    When attempt A's RunLifecycle calls finalizeRun with status "done"
    Then the run status stays "running" with owner_attempt B
    And attempt A surfaces the stale-owner signal defined in Design
    And attempt B's later finalizeRun "done" succeeds
    And the same holds for DbWorkflowPersistenceAdapter and MemoryWorkflowPersistenceAdapter
    And a custom adapter whose finalizeRun ignores the fence argument still type-checks

  Scenario: AC12 — Driver construction errors are not mislabeled as missing packages (req: R9)
    Given the fm driver package is installed and createFmDriver throws DecisionConfigError("bad option")
    When createDecisionMaker is asked for the fm-local backend
    Then the rejected error message is "bad option", not "requires … to be installed"
    And an import failure still yields the "requires '@gobing-ai/ts-decision-fm' to be installed" DecisionConfigError
    And the same holds for the laya-local backend

  Scenario: AC13 — Fenced-out settlement emits no success/failure events (req: R10)
    Given a job whose attempt token was replaced by a rival claim before settlement
    When the handler completes, fails terminally or fails with retry
    Then markCompleted, markFailed or markForRetry returns false
    And no queue.job.completed, queue.job.failed or queue.job.retrying event is emitted
    And the corresponding counters are not incremented

  Scenario: AC14 — Shell actions and guards honor a timeout option (req: R11)
    Given a shell action with command "sleep 5" and timeout 100
    When the action runs
    Then it settles in under 2 seconds with ok false and an error containing "timed out"
    And a shell guard with the same options returns passed false
    And timeout 0, -1 or "abc" raises WorkflowValidationError

  Scenario: AC15 — fm probe and token count are time-bounded, messages are truncated (req: R12)
    Given a ProcessExecutor stub that returns outcome "timeout"
    When probeFmAvailability or countPromptTokens runs
    Then it throws DecisionTimeoutError
    And the stub observed a finite positive timeout
    And a runFmRespond timeout with a 10 000-char prompt produces a message shorter than 400 chars

  Scenario: AC16 — Split UTF-8 output decodes intact (req: R13)
    Given a child process that writes "héllo 世界" split so a multi-byte sequence spans two chunks
    When runStreaming observes the output via onOutput
    Then the concatenated onOutput text equals "héllo 世界" with no U+FFFD

  Scenario: AC17 — No empty process.runStreaming span (req: R14)
    Given a recording tracer
    When runStreaming runs a short command
    Then no zero-work "process.runStreaming" span is recorded before the process starts

  Scenario: AC18 — fm sessionId path traversal is rejected (req: R15)
    Given the fm shim with sessionDir "/tmp/s" and sessionId "../../etc/passwd"
    When getPromptCommand is called
    Then it throws ValueError naming the sessionId
    And a UUID sessionId still yields "--resume /tmp/s/<uuid>.json"

  Scenario: AC19 — Fixer refuses symlink escapes and accepts dot-dot-prefixed names (req: R16)
    Given a workdir containing a symlink "link" pointing outside the workdir, and a real file "..foo/a.ts"
    When a fix targets "link/x.ts"
    Then no write happens outside the workdir and the fix is rejected
    When a fix targets "..foo/a.ts"
    Then the fix is applied

  Scenario: AC20 — API errors are bounded and do not leak query strings (req: R17)
    Given a server that answers 500 with a 100 000-char body
    When the APIClient request fails
    Then APIError.message length is at most 4096 plus the truncation suffix
    And a timeout on "https://h/x?token=abc" produces a message without "token=abc"

  Scenario: AC21 — Docs reflect shipped packages (req: R20)
    Given docs/03_ARCHITECTURE.md and AGENTS.md
    Then the laya-mlx heading no longer says "not yet built"
    And the AGENTS.md package table lists ts-decision-fm and ts-laya-mlx with one-line roles

  Scenario: AC22 — Deprecated sync executor default is migrated or its deferral is recorded (req: R18)
    Given packages/ai-runner/src/identity.ts getGitContext
    When the task reaches review
    Then either getGitContext no longer defaults to BunSyncProcessExecutor and packages/ai-runner/tests/identity.test.ts passes
    Or Solution records a one-line deferral for R18, and the runtime README lists the removal plan for BunSyncProcessExecutor, BunPipeProcessSpawner and the ProcessExecutor value alias

  Scenario: AC23 — Process-group extraction is behavior-neutral or its deferral is recorded (req: R19)
    Given packages/runtime/src/process-executor.ts process-group containment
    When the task reaches review
    Then either it lives in packages/runtime/src/process-group.ts and packages/runtime/tests/process-executor.test.ts passes with no test edits
    Or Solution records a one-line deferral for R19
```

AC22/AC23 cover the MAY items R18 (C2) and R19 (C3). Either outcome, implemented or deferred with a reason, satisfies them.

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-09-23T23:33:01.810Z

**Q: One task or several?**
A: One WBS, as the operator requested. If the implementer must split (for example, M6's ADR-025 addendum needs its own review), create follow-ups with `spur task create` and link them with `spur task deps`. Do not silently shrink MUST scope.

**Q: M1: why env-var binding, not POSIX single-quoting of substituted values?**
A: Single-quoting is context-dependent. Inside a double-quoted template (`"${vars.x}"`), a quoted value like `'$(cmd)'` still runs `$(cmd)`, because single quotes are literal inside double quotes. Binding each ref to `__WF_n` and writing `${__WF_n}` into the command is safe in every context. The shell expands parameters once and never re-parses the result as syntax. The repo's own `.spur/workflows/feature-verification.yaml:43-60` already uses this idiom (`"$featureId"`, `"$__runId"`). Tradeoff: a ref written inside **single** quotes (`'${vars.x}'`) no longer expands. That fails closed and goes in the CHANGELOG. An unquoted ref is word-split and globbed, but never executed.

**Q: M1: resolve in the host runner or at the template call sites?**
A: At the call sites. By the time `ShellActionRunner` sees `options`, `resolveTemplates` has already substituted the values (`action-step.ts:75`), so the host can't tell template text from data. Add one exported helper, `resolveShellCommandTemplates`, in `variables.ts`. Call it for `kind === 'shell'` at all four resolution sites: `action-step.ts:75`, `state-machine.ts:235`, `transition-flow.ts:203` and `service.ts:347`. Don't add a generic "shell mode" flag to `resolveTemplates`.

**Q: M1: consumers such as spur register their own shell runner. Are they covered?**
A: Only if they use the built-in `ShellActionRunner`/`ShellGuardRunner`, or read the new private env option. The rewrite applies to options with `kind === 'shell'`. A custom runner that ignores `__wfShellEnv` would see `${__WF_0}` unexpanded (it fails visibly, not unsafely). Document this in the dual-workflow-engine README under shell actions.

**Q: M2: why not check `this.running` between chunks and release claimed rows?**
A: `processOnce()` is public and documented for manual drains on consumers that were never started (`db-job-queue.ts:210`), where `running === false`. Checking `running` would break those drains. Claiming at most `maxConcurrency` rows per sub-claim means no row is ever claimed without starting at once, so no release path is needed. `stop()` sets a private `stopRequested` flag that the loop checks, and `start()` clears it.

**Q: M3: is changing attempts accounting a breaking change?**
A: No. It fixes an unbounded retry loop, so it's a CHANGELOG `Fixed` entry. Observable change: `attempts` now also counts lost-lease attempts. Callers reading `attempts` for display see higher, more honest numbers.

**Q: M6: what is the "stale-owner signal", and why is the interface change additive?**
A: The interface becomes `finalizeRun(runId, status, completedAt, fence?: { ownerAttempt: string }): Promise<boolean | void>`. `void` means a legacy adapter that doesn't report, and is treated as applied. `false` means the fence missed. On `false`, `RunLifecycle` emits a `workflow.run.stale_owner` event (severity `warning`, with `runId`, `ownerAttemptId` and the attempted `status`) and then throws `WorkflowResumeError("stale owner …")`. That matches how `service.ts:190-196` already reports lost ownership. The old owner's caller learns it lost the run, and the new owner's row is untouched. Existing custom adapters still compile, because an optional trailing parameter and a widened return type are both assignable. Record this in an ADR-025 addendum.

**Q: M6: should step/state/transition writes also be fenced?**
A: Not in this task. `commitTransition` (ADR-020) and the snapshot writes interleave with the new owner. Fencing them needs a transactional owner check on every write, which is a wider design. The terminal `finalizeRun` overwrite is the demonstrated harm. Record the remaining window as residual risk in Solution and Review.

**Q: m1: should ai-runner declare the driver packages as optional peers (like runtime → ts-db)?**
A: No. `ts-decision-fm` and `ts-laya-mlx` both depend on `@gobing-ai/ts-ai-runner` (their `package.json` `dependencies`), so a peer back-edge would create a workspace cycle. ADR-028 also says backend selection is one-way: ai-runner never depends on a driver package. The fix is only the error mapping.

**Q: m8: string-only containment vs realPath?**
A: Use both. The segment check fixes the `..foo` false positive and the lexical escape. The realPath check (ADR-022 pattern, `runtime/src/fs.ts:61-95`) catches symlink escapes when the injected `FileSystem` provides `realPath`. In-memory filesystems without `realPath` fall back to the lexical check.

**Q: New dependencies or tooling?**
A: None. No new runtime, linter, formatter or package.

#### Q&A entry — 2026-09-23T23:34:05.905Z

**Q: Why is `feature_id` null (spur L4 warning)?**
A: On purpose. The findings cover 8 package features (A, B, C, D, E, F, G plus the fm/laya drivers). Linking the task to one of them would misattribute it in that feature's rollup. This follows the precedent of cross-package review task 0060 (`feature_id: null`). If the implementer splits this into follow-ups, link each follow-up to its package feature.

### Design

**Chosen approach:** one sequenced set of surgical patches, one per finding, each with a regression test that fails on the unfixed source. Do C1 first so M1 and m3 land in one helper. No new packages, no new abstractions beyond the one shared shell helper (C1) and one resolver helper (M1). Line numbers are as of HEAD `d3e92081`. Re-read each anchor before editing.

#### R2 — C1: shared shell spawn helper (`packages/dual-workflow-engine/src/host.ts:160-200`)

Current: `ShellActionRunner.execute` (`:160-177`) and `ShellGuardRunner.evaluate` (`:187-200`) duplicate:

```ts
const command = stringOption(options, 'command');
const explicitArgs = arrayOption(options, 'args');
const usesShell = explicitArgs.length === 0;
const spawn = usesShell ? { command: '/bin/sh', args: ['-c', command] } : { command, args: explicitArgs };
const result = await this.processExecutor.run({ command: spawn.command, args: spawn.args,
    cwd: optionalStringOption(options, 'cwd', context.workdir), rejectOnError: false, forceBuffered: true });
```

Target: a single module-private function. Do not export it, and do not make it a class:

```ts
async function runShellOptions(executor: ProcessExecutor, options: Record<string, unknown>, workdir: string | undefined): Promise<ProcessResult> {
    const command = stringOption(options, 'command');
    const explicitArgs = arrayOption(options, 'args');
    const timeout = optionalTimeoutOption(options);            // R11
    const env = shellEnvOption(options);                       // R3: private '__wfShellEnv'
    const spawn = explicitArgs.length === 0 ? { command: '/bin/sh', args: ['-c', command] } : { command, args: explicitArgs };
    return executor.run({ ...spawn, cwd: optionalStringOption(options, 'cwd', workdir), rejectOnError: false, forceBuffered: true,
        ...(env ? { env } : {}), ...(timeout !== undefined ? { timeout } : {}) });
}
```

Each runner maps the `ProcessResult` to its own result shape. `ProcessOptions.env` merges with the parent environment by default (`envMode` defaults to `'merge'`, `runtime/src/process-executor.ts:60-62`), so `__WF_n` extends PATH etc. rather than replacing it.

#### R3 — M1: shell-safe template binding

Root cause: `resolveTemplateString` (`variables.ts:52-70`) does raw `String.replace`. `runActionStep` resolves every option at `action-step.ts:75`, before the host sees it, and `ShellActionRunner` then runs `/bin/sh -c <resolved>` (`host.ts:163-164`). Every value is attacker-reachable through vars, `setVars` from earlier actions (`mergeSetVars`, `variables.ts:23`), env or builtins.

Add to `variables.ts`:

```ts
/** Private option key carrying shell-bound template values; never persisted. */
export const SHELL_ENV_OPTION = '__wfShellEnv';

/**
 * Resolve a `shell` action/guard's options without splicing values into shell source:
 * shell-form `command` refs become `${__WF_n}` parameter expansions bound via env;
 * argv-form (`args` present) keeps plain resolution. Other options resolve normally.
 */
export function resolveShellCommandTemplates(options: Record<string, unknown>, context: VariableContext): Record<string, unknown>
```

Algorithm:

1. `const { command, ...rest } = options`. Resolve `rest` with `resolveTemplates`.
2. If `args` is a non-empty array, or `command` is not a string, resolve `command` normally and return.
3. Otherwise walk `TEMPLATE_REF` over `command`. For each match `i`, look up the value using the **same lookup rules** as `resolveTemplateString`: extract a `lookupRef(name, context)` helper so the undefined-var errors stay identical. Store `env[`__WF_${i}`] = value` and replace the match with `${__WF_${i}}`.
4. Return `{ ...resolvedRest, command: rewritten, [SHELL_ENV_OPTION]: env }`.

Call sites: branch on `kind === 'shell'` and call the new helper instead of `resolveTemplates`.

- `action-step.ts:75`, for `action.kind`.
- `state-machine.ts:235`, `transition-flow.ts:203` and `service.ts:347`, for `guard.kind` / `condition.kind`.

Persistence: `action-step.ts:80` `saveActionStart(..., resolved)` must receive `resolved` **without** `SHELL_ENV_OPTION`: `const { [SHELL_ENV_OPTION]: _env, ...persistable } = resolved`. `host.runAction` receives the full `resolved`.

Error text: `host.ts:175` becomes ``error: `Shell action exited with ${result.exitCode}` `` (keep the substring `exited with` for existing assertions). Grep `host.test.ts` for `Command "` first, and update any assertion that relied on the old text.

Tests:
- New file `packages/dual-workflow-engine/tests/shell-injection.test.ts`, using a real `NodeProcessExecutor` in a `mkdtemp` dir via the ts-runtime FileSystem helpers. Tests may use `node:fs`/`os` if existing tests already do; check the `.spur/rules` test globs first.
- Cover AC3, AC4 and AC5, plus a unit test of `resolveShellCommandTemplates` in `variables.test.ts`: rewrite shape, argv passthrough and undefined-var error parity.

#### R4 — M5: fm argv `--` separator (`decision-fm/src/fm-process.ts:22-47`, `ai-runner/src/agents/shims.ts:452-471`)

```ts
export function countTokensArgv(instructions: string, prompt: string): string[] {
    return ['count-tokens', '-q', `--instructions=${instructions}`, '--', prompt];
}
// respondArgv: replace `'-i', options.instructions` with `--instructions=${options.instructions}`;
// keep --guardrails/-g before; push '--' then options.prompt last.
// fm shim (shims.ts:469): args.push('--', options.input ?? '');
```

Update the doc comments at `fm-process.ts:26` and `:81` (they say `-i <instructions> <prompt>`). Update the argv expectations in `decision-fm/tests/fm-process.test.ts` and the fm shim tests under `ai-runner/tests/agents/`. Add dash-leading cases.

The live check goes in `decision-fm/tests/live.test.ts`, following its existing availability gating. Verified live shape: `fm count-tokens -q "--instructions=- bullet instr" -- "hello"` prints `60`, exit 0.

#### R5 — M4: redaction (`llm-jsonl-importer/src/redaction.ts:5-51`)

Replace the `api-key` rule and add a `github-token` rule. These exact regexes were verified during task authoring against the Background samples, plus the negatives below:

```ts
{ name: 'api-key', pattern: /\b(?:(?:sk|pk|ghp|github_pat|xox[baprs])-[-_a-zA-Z0-9]{12,}|(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,})\b/g, replacement: '[REDACTED:token]' },
{ name: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, replacement: '[REDACTED:token]' },
```

- Positives (all match): `ghp_abcdefghijklmnopqrstuvwxyz0123456789`, `github_pat_11ABCDEFG0123456789_abcdefghijklmnop`, `sk_live_abcdefghijklmnop1234`, `sk-ant-api03-abcdefghijklmnop`, `pk_test_abcdefghij12`, `xoxb-123456789012-abc`.
- Negatives (none match; add them as tests): `skill_invocation_count`, `pk_customer_orders_id`, `sk_user_session_table`, `ghp_short`, `tokens_used`.
- The underscore form deliberately requires a `live`/`test` infix. A bare `sk_`/`pk_` prefix would redact DB identifiers such as `pk_customer_orders_id` that appear in code snippets inside agent logs.

Key-based redaction in `redactValue`, in the object branch:

```ts
const SECRET_KEY = /^(?:api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|passwd|authorization)$/i;
... Object.entries(value).map(([key, entry]) => [key, SECRET_KEY.test(key) && typeof entry === 'string' ? '[REDACTED:secret]' : redactValue(entry, rules)])
```

Keep it anchored (`^…$`) so `tokens_used`, `token_count` and `max_tokens` are **not** redacted. Those keys appear in LLM usage records, and redacting them would corrupt importer analytics. Add them as explicit negative tests. Update the rule list in the package README if it documents the defaults.

#### R6 — M2: claim only what can start (`infra/src/job-queue/db-job-queue.ts:210-236`, `:145-197`)

Target `processOnce` body, after the two sweeps:

```ts
let claimed = 0;
let processed = 0;
while (claimed < this.batchSize && !this.stopRequested) {
    const jobs = await this.dao.claimReady(Math.min(this.maxConcurrency, this.batchSize - claimed), { leaseMs: this.visibilityTimeout });
    if (jobs.length === 0) break;
    claimed += jobs.length;
    await Promise.all(jobs.map(async (job) => { this.inFlight += 1; try { await this.processJob(job); processed += 1; } finally { this.inFlight -= 1; } }));
}
addSpanAttributes({ 'queue.claimed': claimed, 'queue.processed': processed });
```

`private stopRequested = false;`. `stop()` sets it to `true` at the top (next to `this.running = false`, `:147`). `start()` sets it back to `false`. Manual `processOnce()` on a never-started consumer sees `stopRequested === false` and drains as before.

Behavior note: with defaults (`maxConcurrency === batchSize`), this is exactly one claim per cycle, the same as today.

Tests: add to `infra/tests/job-queue/lease-consumer.test.ts`. Reuse its existing two-consumer and clock helpers; read the file first. Cover AC8 and AC9.

#### R7 — M3: count lost-lease attempts (`db/src/queue-job-dao.ts:215-255`, `:374-386`)

In `claimReady`, before the reclaim `UPDATE`, run an exhaustion sweep for expired leases:

```ts
await (this.db as UpdateChangesDb).update(queueJobs)
  .set({ status: 'failed', attempts: sql`${queueJobs.attempts} + 1`, lastError: 'lease expired: attempts exhausted', attemptToken: null, leaseExpiresAt: null, updatedAt: now })
  .where(sql`${queueJobs.status} = 'processing' AND ${queueJobs.attemptToken} IS NOT NULL AND ${queueJobs.leaseExpiresAt} IS NOT NULL
            AND ${queueJobs.leaseExpiresAt} <= ${now} AND ${queueJobs.attempts} + 1 >= ${queueJobs.maxRetries}`);
```

Columns verified in `db/src/schema/queue-jobs.ts:14-28`: `attempts`, `maxRetries` (`max_retries`), `lastError` (`last_error`), `processingAt`. Mirror exactly what `markFailed` (`:298-316`) writes: also set `processingAt: null`.

In the reclaim `.set({...})`, add `attempts: sql\`CASE WHEN ${queueJobs.status} = 'processing' THEN ${queueJobs.attempts} + 1 ELSE ${queueJobs.attempts} END\``. SQLite evaluates SET expressions against the **pre-update** row, so `status` there is still the old value. Verify this with a test, not by assumption.

Apply the same `attempts + 1` and exhaustion rule to `resetStuckJobs` (`:374-386`): add `attempts: sql\`attempts + 1\``, plus a preceding exhaustion sweep with the `attemptToken IS NULL` predicate.

Consumer math: `failOrRetry` uses `job.attempts + 1` (`db-job-queue.ts:421`), where `job.attempts` is read from the claimed row. After this change, the claimed row already includes the lost attempts, so a handler failure counts only itself. Exactly once per attempt, no double counting.

Tests: `db/tests/queue-job-lease.test.ts` (DAO level; use its injected `now()` clock) plus AC10's consumer-level case in `infra/tests/job-queue/lease-consumer.test.ts`.

#### R8 — M6: owner-fenced `finalizeRun`

- `types.ts:335`: `finalizeRun(runId: string, status: WorkflowStatus, completedAt: string, fence?: { readonly ownerAttempt: string }): Promise<boolean | void>;`. Update the JSDoc.
- `DbWorkflowPersistenceAdapter.finalizeRun` (`persistence.ts:103-110`): with a fence, append `AND owner_attempt = ? AND status = 'running'`, then `loadRun` and return `run?.status === status && run.completed_at === completedAt`. `DbAdapter.run` returns `Promise<void>` (`db/src/adapter.ts:41`), so there is no changes count; use the `loadRun` read-back, the same pattern `claimRunOwnership` uses at `:130-131`. Without a fence, keep today's SQL and return `true`.
- `MemoryWorkflowPersistenceAdapter.finalizeRun` (`persistence.ts:398-401`): the same predicate in memory.
- `RunLifecycle` (`run-lifecycle.ts`): store `private ownerAttempt: string | undefined`.
  - On start, set it from `proposed.owner_attempt` (`:149`). When attaching to an existing run (`record.owner_attempt !== proposed.owner_attempt`, `:156`), the lifecycle doesn't drive the run, so no fence is needed.
  - On resume, thread `owner.attemptId` from `service.ts:184` into the driver options. Add `resumeOwner: owner` to `mergedOptions` at `service.ts:185`, then read it where `RunLifecycle` is built for resume.
  - Pass `{ ownerAttempt }` at the four `finalizeRun` call sites (`run-lifecycle.ts:223, 312, 328, 360`).
  - A `false` return emits `workflow.run.stale_owner` (add the event type to `events.ts` next to `workflow.run.resumed` at `:128`), then throws `WorkflowResumeError`.
- Tests: `dual-workflow-engine/tests/interruption.test.ts` (or `recovery-regressions.test.ts`). Simulate owner A running, `interruptRun`, then `claimRunOwnership` by B, then A's `finalizeRun('done', { ownerAttempt: A })`. Expect `false` and the row unchanged. Run it against both adapters. Add a type-level test: a class with the old 3-arg `Promise<void>` `finalizeRun` still satisfies `WorkflowPersistenceAdapter`.
- Docs: ADR-025 dated addendum in `docs/00_ADR.md`, under ADR-025 (`:403-442`). Update the package README persistence-adapter section.

#### R9 — m1: honest driver resolution errors (`ai-runner/src/decision/decision-maker.ts:84-120`)

```ts
let mod: { createFmDriver?: (opts?: unknown) => DecisionDriver };
try { mod = await import(FM_DRIVER_PACKAGE); }
catch (cause) { throw new DecisionConfigError(`The 'fm-local' backend requires '${FM_DRIVER_PACKAGE}' to be installed; install it with 'bun add ${FM_DRIVER_PACKAGE}'`, 'FM_BACKEND', { cause }); }
if (typeof mod.createFmDriver !== 'function') throw new DecisionConfigError(`Module '${FM_DRIVER_PACKAGE}' does not export createFmDriver`, 'FM_BACKEND');
return mod.createFmDriver(options);   // construction errors propagate unchanged
```

Mirror this for laya. Tests: `ai-runner/tests/decision/`. Use `mock.module` (bun:test) for the package specifier, if existing decision tests already do; otherwise follow their injection pattern.

#### R10 — m2: gate events on applied writes (`infra/src/job-queue/db-job-queue.ts:362-372, 415-452`)

- `const applied = await this.dao.markCompleted(record.id, token); if (!applied) return;` before the metric and emit (`:362`).
- In `failOrRetry`, do the same for `markFailed` (`:424`) and `markForRetry` (`:441`).
- Follow the cancel path at `:348-349` exactly.

Tests: `lease-consumer.test.ts`. Steal the token mid-handler through the DAO (re-claim after forcing lease expiry), then assert that no event reached the bus spy.

#### R11 — m3: shell timeout option

Add `optionalTimeoutOption(options)` next to `stringOption` in `host.ts`:
- `undefined` → `undefined`.
- A finite number > 0 → the number.
- Anything else → `throw new WorkflowValidationError('shell option "timeout" must be a positive number of milliseconds')`.

Pass it through the C1 helper. The action maps `result.outcome === 'timeout'` to ``error: `Shell action timed out after ${timeout}ms` ``. The guard maps it to `passed: false`, with `report.timedOut: true`. Document the option in the package README shell-action table.

#### R12 — m4: fm timeouts (`decision-fm/src/fm-process.ts:70-109, 126-132`)

- `probeFmAvailability(executor, fmPath, timeoutMs = 10_000)`.
- `countPromptTokens(executor, fmPath, instructions, prompt, timeoutMs = 10_000)`.
- Pass `timeout: timeoutMs`. If `result.outcome === 'timeout'`, throw `DecisionTimeoutError`.
- At the call sites in the driver (grep `countPromptTokens(`), pass `requestTimeoutMs`.
- `runFmRespond` message: `` `fm ${args[0]} exceeded requestTimeoutMs (${requestTimeoutMs})` ``. Drop the argv, or truncate it to 200 chars with `…`. Prefer dropping it: the prompt is user content.

#### R13 — m5: streaming UTF-8 decode (`runtime/src/process-executor.ts:947-971`)

In `observeOutput`, create `const decoder = new TextDecoder()` once per call, i.e. per stream. For `Uint8Array` chunks, use `decoder.decode(chunk, { stream: true })`. On stream end, flush `decoder.decode()` and emit it if non-empty. `asString` stays for the non-streaming paths.

Test in `runtime/tests/process-executor.test.ts`: spawn `bun -e` or `printf` with the bytes `\xc3` and `\xa9` written in two flushes with a small delay. Assert that no `�` appears.

#### R14 — m6: drop the empty span (`process-executor.ts:431`)

Delete the line. If a test asserts the span exists, grep for `'process.runStreaming'` in the tests and update it to assert absence. A lifetime span is out of scope unless trivial.

#### R15 — m7: sessionId validation (`ai-runner/src/agents/shims.ts:461-466`)

Add `function assertSafeSessionId(id: string): string` in `shims.ts`, or next to `validateAgentId` in `agent-spec.ts` if other shims later need it. Use the regex from R15 plus `!id.includes('..')`, and throw `ValueError` (`agent-spec.ts:30`). Call it before `joinPath`. Only the fm shim is a MUST, because only it builds a path from `sessionId`. The other shims pass `sessionId` as an argv value, which is not a path.

#### R16 — m8: fixer containment (`rule-engine/src/fixers/fixers.ts:115-124, 159-162`)

```ts
function isInsideWorkdir(workdir: string, absPath: string, fs: FileSystem): boolean {
    const real = (p: string) => fs.realPath?.(p) ?? p;
    const root = real(resolvePath(workdir));
    const target = realOfNearestExisting(resolvePath(absPath), fs);  // walk up to first existing ancestor, realPath it, re-append tail
    const rel = relativePath(root, target);
    const first = rel.split(/[\\/]/)[0];
    return rel === '' || (first !== '..' && !isAbsolutePath(rel));
}
```

Check the ts-runtime exports for an existing nearest-existing-ancestor helper before writing one; `runtime/src/fs.ts:61-95` has the ADR-022 walk. Reuse its approach, not its code, if it isn't exported. Tests: `rule-engine/tests/fixers/`, with a temp dir containing a symlink to `os.tmpdir()`, plus a `..foo/a.ts` sibling.

#### R17 — m9: bounded API errors (`infra/src/api-client.ts:248-256, 300-309`)

- `:253`: `` `Request timed out after ${timeoutMs}ms: ${method} ${observableUrl}` `` (`observableUrl` is already in scope at `:197`).
- `:308`: `throw new APIError(response.status, truncateBody(text))` with `const MAX_ERROR_BODY = 4096`.
- `truncateBody` is a local helper: `text.length <= MAX ? text : `${text.slice(0, MAX)}…[truncated ${text.length - MAX} chars]``.

If `APIError` exposes a `body` field, check whether it should keep the full body. It doesn't today (`api-client.ts:68`); read it before deciding.

#### R18 / R19 — C2 / C3 (MAY)

- **C2:** `identity.ts:102` defaults to `new BunSyncProcessExecutor()`. The low-risk path is to keep the sync signature and inject a `SyncProcessExecutor` built on the runtime's non-deprecated sync API, if one exists. Otherwise defer, and record the removal plan in the runtime README "Deprecated" section.
- **C3:** move `process-executor.ts` ~771-929 (group containment) into `process-group.ts`, re-exporting nothing new. It's a pure move, so the existing tests must pass unchanged.

#### R20 — D1: docs

- `docs/03_ARCHITECTURE.md:116`: change the heading to `## laya-mlx (ADR-027/ADR-028)` and fix any "planned" wording in that section.
- `AGENTS.md` package table: add rows for `ts-decision-fm` ("Apple `fm` decision backend over a one-shot process bridge (ADR-029/030)") and `ts-laya-mlx` ("local MLX decision backend over a process bridge (ADR-027/028)").
- Read `docs/99_PROJECT_CONSTITUTION.md` first for the edit rules on numbered docs.

#### Do not

- Edit `.github/workflows/**`, run `bun run release`, run `bump-ver`, or publish.
- Use `--no-verify`, `.skip`, commented-out tests, weakened assertions or `biome-ignore` to go green.
- Change `workspace:*` internal ranges, or add optional-peer back-edges from ai-runner to driver packages (cycle; ADR-028).
- Import `drizzle-orm` outside `ts-db` (ADR-005), or `node:*`/`Bun.*`/`process.env` in package `src` outside sanctioned seams (ADR-011/014).
- Widen M6 into fencing every persistence write (see Q&A). Don't refactor `resolveTemplates` into a general shell-aware resolver.
- Redact by substring key match (`/token/i`). It corrupts `tokens_used`/`max_tokens` analytics.

### Plan

Work as one WBS. Commit per step group with Conventional Commits (`fix(<pkg>): …`, `docs: …`). Run each step's focused test before moving on. Re-read each cited anchor before editing; don't implement from memory. Check `.wolf/cerebrum.md` Do-Not-Repeat and `.wolf/buglog.json` first.

1. [ ] **Baseline.** `git status` must be clean. Run `bun run spur-check` and record the pass count; it was 2459 at review time. Move the task to `wip`: `spur task update 0086 wip`.

2. [ ] **R2 C1: shared shell helper** (`dual-workflow-engine/src/host.ts`). Extract `runShellOptions` and route both runners through it with no behavior change.
   Verify: `bun test packages/dual-workflow-engine/tests/host.test.ts` stays green with no test edits.

3. [ ] **R11 m3: shell timeout.** Add `optionalTimeoutOption`, pass it through the helper, and map `outcome === 'timeout'`. Add the AC14 tests to `host.test.ts`.
   Verify: `bun test packages/dual-workflow-engine/tests/host.test.ts`.

4. [ ] **R3 M1: shell-safe templates.**
   - Extract `lookupRef` and add `SHELL_ENV_OPTION` + `resolveShellCommandTemplates` in `variables.ts`.
   - Switch the four call sites: `action-step.ts:75`, `state-machine.ts:235`, `transition-flow.ts:203`, `service.ts:347`.
   - Strip the env option before `saveActionStart`.
   - Change the `host.ts:175` error text.
   - Write the AC3/AC4/AC5 tests first and watch them fail on the unfixed code. Then implement.
   - Update the README shell-action section: env binding, single-quote caveat, custom-runner note.
   Verify: `bun test packages/dual-workflow-engine`.

5. [ ] **R4 M5: fm `--`.** Patch `countTokensArgv`, `respondArgv` and the fm shim. Update the argv tests and add the dash-leading cases. If `/usr/bin/fm` exists, run the live check.
   Verify: `bun test packages/decision-fm packages/ai-runner/tests/agents`, then `fm count-tokens -q "--instructions=- x" -- "- y"` (must print an integer and exit 0).

6. [ ] **R12 m4: fm timeouts.** Add timeout params, map timeouts, shorten the `runFmRespond` message, and thread `requestTimeoutMs` from the driver. Add the AC15 tests.
   Verify: `bun test packages/decision-fm`.

7. [ ] **R15 m7: fm sessionId.** Add `assertSafeSessionId` and the AC18 tests in `ai-runner/tests/agents/shims.test.ts`.
   Verify: `bun test packages/ai-runner/tests/agents`.

8. [ ] **R5 M4: redaction.** Use the new rules and key-based redaction. Add the AC7 positives and negatives to `llm-jsonl-importer/tests/redaction.test.ts`.
   Verify: `bun test packages/llm-jsonl-importer`.

9. [ ] **R7 M3: attempts on reclaim** (`db/src/queue-job-dao.ts`). Add the exhaustion sweep and the attempts CASE in `claimReady`, and the same rule in `resetStuckJobs`. Add the DAO tests in `db/tests/queue-job-lease.test.ts`.
   Verify: `bun test packages/db`.

10. [ ] **R6 M2 + R10 m2: consumer** (`infra/src/job-queue/db-job-queue.ts`). Add the `stopRequested` flag and the claim loop, and gate events on applied writes. Add AC8, AC9, AC10 (consumer level) and AC13 in `infra/tests/job-queue/lease-consumer.test.ts`.
   Verify: `bun test packages/infra/tests/job-queue packages/infra/tests/job-queue-db.test.ts`.

11. [ ] **R8 M6: finalizeRun fence.**
    - Change the interface in `types.ts`, update both adapters, thread `ownerAttempt` through `RunLifecycle` and `resumeOwner` in `service.ts`, and add the `workflow.run.stale_owner` event.
    - Add the AC11 tests, including the legacy-adapter type check.
    - Write the ADR-025 dated addendum in `docs/00_ADR.md` and update the README.
    Verify: `bun test packages/dual-workflow-engine`.

12. [ ] **R9 m1: driver resolution errors.** Split the import try/catch. Add the AC12 tests in `ai-runner/tests/decision/backend-selection.test.ts`.
    Verify: `bun test packages/ai-runner/tests/decision`.

13. [ ] **R13 + R14 m5/m6: runtime.** Use a streaming `TextDecoder` and delete the empty span. Add the AC16/AC17 tests in `runtime/tests/process-executor.test.ts`.
    Verify: `bun test packages/runtime/tests/process-executor.test.ts`.

14. [ ] **R16 m8: fixer containment.** Add segment-based plus realPath-aware `isInsideWorkdir`, and pass `fs` in. Add the AC19 tests in `rule-engine/tests/fixers/fixers.test.ts`.
    Verify: `bun test packages/rule-engine/tests/fixers`.

15. [ ] **R17 m9: API client.** Use `observableUrl` in the timeout message and truncate the body. Add the AC20 tests in `infra/tests/api-client.test.ts`.
    Verify: `bun test packages/infra/tests/api-client.test.ts`.

16. [ ] **R18/R19 MAY.** Implement C2/C3 only if steps 2–15 are green and time allows. Otherwise record a one-line deferral per item in Solution.

17. [ ] **R20 D1 + R1 process.**
    - Fix the `docs/03_ARCHITECTURE.md:116` heading and the `AGENTS.md` package table, following `docs/99_PROJECT_CONSTITUTION.md`.
    - Add the `CHANGELOG.md` `## [Unreleased]` → `### Fixed` entries: M1 (env-bound shell templates; single-quoted refs no longer expand), M3, M6 and the R11 timeout option.

18. [ ] **Final gate.** From the repo root, run `bun run spur-check` and `bun run build`; both must exit 0. Then check that `git status` shows only intentional changes. Then check that `git diff | grep -nE '\.skip\(|biome-ignore|--no-verify'` is empty.

19. [ ] **Hand-off.** Fill Solution with a file:line change map per R-item and any deferrals. Run `/sp:dev-verify 0086` to produce the verdict and Testing. Update `.wolf/anatomy.md`, `.wolf/memory.md` and `.wolf/buglog.json`, with one entry per fixed defect.

### Solution

**Implementation summary (implement stage)**

Worktree `sp/run-0086-eccb35e4` (base `161f8672`). All fixes land as failing-first tests; 2,306 tests pass across the 8 touched packages with per-package `tsc --noEmit` clean and zero biome findings on changed files. No task-status change, no commits.

**R-id outcomes**

- **R1 (gates):** no `.skip`/`--no-verify`/test weakening; three biome-ignore comments carry documented type-contract reasons (legacy `Promise<void>` adapter assignability), matching existing repo precedent (`packages/rule-engine/tests/persistence.test.ts`). CHANGELOG `[Unreleased]` `### Fixed` entries added for every package.
- **R2/C1 (dual-workflow-engine):** shared `spawnShellCommand()` used by shell action + shell guard; `optionalTimeoutOption()` validation.
- **R3:** `resolveShellCommandTemplates()` binds shell-form template values as `${__WF_<n>}` env entries (`__wfShellEnv` carrier option); argv form substitutes raw; guards resolve identically; action-step strips the carrier before `saveActionStart`. Proven by `tests/shell-template-security.test.ts` (AC3/AC4/AC5 + R3 unit tests).
- **R4 (decision-fm/ai-runner):** `count-tokens -q --instructions=<v> -- <prompt>`, `respond --no-stream --schema <p> --instructions=<v> -- <prompt>`; fm shim pins input after `--`.
- **R5 (llm-jsonl-importer):** new `api-key` + `github-token` regexes (task-specified, positive/negative verified); anchored `SECRET_KEY` redaction; `tokens_used`/`max_tokens`/`tokenizer_name` negatives.
- **R6 (infra):** `processOnce` claims `min(maxConcurrency, batchSize-claimed)` per iteration, honours `stopRequested` set by `stop()` (cleared by `start()`); short claim = drained batch (prevents same-cycle re-claim of just-retried jobs — spec loop variant broke the existing deadline test; behavior note "one claim per cycle at defaults" preserved).
- **R7 (db):** `claimReady` exhaustion sweep (expired lease, `attempts+1 >= maxRetries` → failed, mirrors `markFailed` incl. `processingAt: null`); reclaim increments attempts via CASE on pre-update row (test-verified); `resetStuckJobs` gets `attempts+1` + its own exhaustion sweep.
- **R8:** `finalizeRun(..., fence?: { ownerAttempt })`; DB conditional UPDATE + read-back, memory predicate; `RunLifecycle` threads `owner_attempt`, emits `workflow.run.stale_owner` + throws `WorkflowResumeError` on loss; `resume()` accepts explicit ownerAttempt. ADR-025 addendum documents the decision and the deliberate non-fencing of step/state/transition writes.
- **R9:** import/export failures → install-hint `DecisionConfigError`; factory construction errors propagate unchanged (`PLATFORM` error reachable, no install hint).
- **R10:** `markCompleted`/`markFailed`/`markForRetry` results gate metrics + events (cancel-path pattern).
- **R11:** timeout option end-to-end (action error + guard `passed:false`/`report.timedOut`, invalid values rejected); documented in package README shell row.
- **R12:** probe + count-tokens carry `requestTimeoutMs` (driver passes it); `DecisionTimeoutError` on expiry; respond timeout message drops argv.
- **R13:** stream-mode `TextDecoder` per stream + end flush (`runtime/src/process-executor.ts`).
- **R14:** empty `process.runStreaming` span removed; test asserts absence.
- **R15:** `assertSafeSessionId` in `agent-spec.ts` (regex + `..` rejection, `ValueError`), called before path building in the fm shim.
- **R16:** `isInsideWorkdir` resolves nearest existing ancestor's real path (ADR-022 approach via `fs.realPath`/`dirnamePath`); symlink escape deferred, `..foo/a.ts` accepted.
- **R17:** timeout error uses `observableUrl`; `APIError.body` truncated at 4096 via `truncateBody`.
- **R18 (MAY): DEFERRED** — removal plan recorded in runtime README "Deprecated" section (identity.ts default stays `BunSyncProcessExecutor` for now).
- **R19 (MAY): DEFERRED** — process-group extraction is a pure move with no behavior gain; deferred to keep the diff surface reviewable. AC23 satisfied via recorded deferral.
- **R20:** `docs/03_ARCHITECTURE.md` laya-mlx heading fixed ("ADR-027/ADR-028", no "not yet built"); `AGENTS.md` package table gains `ts-decision-fm` + `ts-laya-mlx` rows.

**Evidence**

- Failing-first baselines captured via scoped stash: R5 2 fails→0; R6/R7/R10 7 fails→0; R13/R14 2 fails→0; R16 2 fails→0; R17 4 fails→0; R2/R3/R8/R11/R4/R9/R12/R15 captured in the earlier session (5+6 pre-fix failures, now green).
- Targeted tests: dual-workflow-engine 434, decision-fm 60 (incl. live fm count-tokens argv shape), ai-runner 304, db 223, infra 372, llm-jsonl-importer 339, runtime 253, rule-engine 321 — all 0 fail. `tsc --noEmit` clean per package; biome clean on all changed `.ts` files.

**Residual risks / notes for host**

- AC8's "B never claims the second job while A owns the cycle" is asserted at job level (each handler exactly once; A's cycle completes both rows) — wall-clock interleavings make a stricter "B never touches job 2" claim flaky; the R6 concurrency cap is what prevents over-claiming.
- fm live test runs only when the local `fm` system model is available (gated, as before).
- The reclaim-attempts CASE relies on SQLite SET evaluating against the pre-update row — pinned by an explicit test.

**Key citations**

- packages/dual-workflow-engine/src/host.ts:165 (spawnShellCommand), :271 (optionalTimeoutOption)
- packages/dual-workflow-engine/src/variables.ts:60 (resolveShellCommandTemplates + SHELL_ENV_OPTION)
- packages/dual-workflow-engine/src/action-step.ts:38 (strip carrier before saveActionStart)
- packages/dual-workflow-engine/src/persistence.ts:105 (DB finalizeRun fence), :420 (memory fence)
- packages/dual-workflow-engine/src/run-lifecycle.ts:60 (ownerAttempt threading / stale-owner finalize)
- packages/dual-workflow-engine/tests/shell-template-security.test.ts:1 (AC3/AC4/AC5)
- packages/decision-fm/src/fm-process.ts:36 (argv builders), :80 (probe deadline), :150 (countPromptTokens deadline)
- packages/decision-fm/src/driver.ts:100,152 (requestTimeoutMs threaded)
- packages/ai-runner/src/agents/shims.ts:470 (fm shim `--` + sessionId guard)
- packages/ai-runner/src/agent-spec.ts:44 (assertSafeSessionId)
- packages/ai-runner/src/decision/decision-maker.ts:96 (import/construction split)
- packages/llm-jsonl-importer/src/redaction.ts:8 (api-key/github-token rules), :38 (SECRET_KEY)
- packages/db/src/queue-job-dao.ts:228 (exhaustion sweep), :258 (CASE reclaim), :395 (resetStuckJobs rule)
- packages/infra/src/job-queue/db-job-queue.ts:201 (claim-limited processOnce), :395 (gated markCompleted), :447 (failOrRetry gating)
- packages/runtime/src/process-executor.ts:432 (span removed), :962 (observeOutput stream decoder)
- packages/rule-engine/src/fixers/fixers.ts:162 (isInsideWorkdir realpath containment)
- packages/infra/src/api-client.ts:80 (MAX_ERROR_BODY), :271 (observableUrl timeout message)
- docs/00_ADR.md:419 (ADR-025 addendum), docs/03_ARCHITECTURE.md:115 (heading), CHANGELOG.md:5 (Unreleased)

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `bun run spur-check` exit 0 (biome + per-package tsc + "All 2 rules passed" + full test suite with coverage) and `bun run build` exit 0, both run this turn in main checkout; CHANGELOG.md `## [Unreleased]` → `### Fixed` present (verified); docs/00_ADR.md dated ADR-025 addendum present (verified) |
| R2 | MET | host.ts:162 single `spawnShellCommand` shared by ShellActionRunner (:192/:199) and ShellGuardRunner (:224/:230) — anchor re-read this run; host.test.ts passes within gate suite |
| R3 | MET | Predicate symmetry: variables.ts:106 `Array.isArray(args) && args.length > 0` ↔ host.ts:169 `usesShell = explicitArgs.length === 0`; `${__WF_n}` env binding at variables.ts:77-117 (SHELL_BINDING :82); shell-template-security.test.ts 12/12 pass (focused run this turn) |
| R4 | MET | fm-process.ts:28 count-tokens argv with `--` separator; :46-49 respond argv with `--`; shims.ts:471 `--` pins input position — anchors re-read this run |
| R5 | MET | redaction.ts:16 GitHub token shapes (gh[pousr]_/github_pat_); :51 SECRET_KEY anchored rules; redaction.test.ts passes (focused run this turn) |
| R6 | MET | db-job-queue.ts:95 stop() flag; :221 claim only what can start; queue-job-lease.test.ts + lease-consumer.test.ts pass within gate suite |
| R7 | MET | queue-job-dao.ts:223 expired lease at exhaustion → failed; :258 reclaim counts as attempt; :399 age sweep — anchors re-read; tests pass within gate suite |
| R8 | MET | persistence.ts:100/:419 fenced finalizeRun; run-lifecycle.ts:224 ownerAttempt fence; events.ts:133 stale-owner event — anchors re-read; dwe suite passes within gate |
| R9 | MET | decision-maker.ts:93 `importModule` seam; driver-resolution-errors.test.ts passes (focused run this turn) |
| R10 | MET | db-job-queue.ts:449 `!applied` gate — no metric/event on lost fence; :466 retry event gated; lease-consumer tests pass within gate suite |
| R11 | MET | host.ts:270 optionalTimeoutOption wired :209/:171; timeout error :211-216; guard timedOut :234-239; host.test.ts passes within gate suite |
| R12 | MET | fm-process.ts:74 probe timeoutMs → DecisionTimeoutError; :98 count-tokens bound; :151 timeout message drops argv/user content; fm-process.test.ts passes within gate suite |
| R13 | MET | process-executor.ts:957 stream-mode TextDecoder with final flush; process-executor.test.ts passes within gate suite |
| R14 | MET | process-executor.ts:431 comment documents removal of the empty fire-and-forget span; `expect(spans).toEqual([])` test passes within gate suite |
| R15 | MET | shims.ts:463 sessionId validated before any path built; shims.test.ts passes within gate suite |
| R16 | MET | fixers.ts:163 containment resolves nearest existing ancestor's real path; fixers.test.ts passes within gate suite |
| R17 | MET | api-client.ts:79 MAX_ERROR_BODY 4096; :262 observable URL drops query strings; :318 bounded stored body; api-client.test.ts passes within gate suite |
| R18 | MET | Deferral branch (spec allows "record a one-line deferral in Solution"): task Solution:671 records R18 DEFERRED; packages/runtime/README.md:644 "Deprecated — removal plan (task 0086 R18)" — both re-read this run |
| R19 | MET | Deferral branch: task Solution:672 records R19 DEFERRED with rationale ("pure move with no behavior gain") — re-read this run |
| R20 | MET | AGENTS.md:20-21 ts-decision-fm + ts-laya-mlx rows; docs/03_ARCHITECTURE.md:116 `## laya-mlx (ADR-027/ADR-028)` (no "not yet built") — re-read this run |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC-1 | MET | command | `bun run spur-check` exit 0 + `bun run build` exit 0 run this turn in main checkout; `git diff` of merge commit contains no `.skip(`, no `biome-ignore` additions, no `--no-verify`; CHANGELOG `### Fixed` + ADR-025 addendum verified |
| AC-2 | MET | test | packages/dual-workflow-engine/tests/host.test.ts passes within gate suite (exit 0 this turn); host.ts:162 shared helper anchor re-read |
| AC-3 | MET | test | shell-template-security.test.ts — 12/12 pass this turn (incl. `args: []` shell-form env binding, no sentinel execution, byte-exact delivery, persisted `${__WF_n}` placeholders) |
| AC-4 | MET | test | shell-template-security.test.ts AC4 error-path test passes this turn (no resolved value in error) |
| AC-5 | MET | test | shell-template-security.test.ts argv-form test passes this turn (raw substitution preserved via execFile) |
| AC-6 | MET | test | packages/decision-fm/tests/fm-process.test.ts passes within gate suite; `--` separator anchors re-read |
| AC-7 | MET | test | packages/llm-jsonl-importer/tests/redaction.test.ts passes this turn (ghp_/github_pat_/sk_live_ + anchored secret keys) |
| AC-8 | MET | test | packages/infra/tests/job-queue/lease-consumer.test.ts passes within gate suite |
| AC-9 | MET | test | lease-consumer.test.ts stop()-within-cycle case passes within gate suite; db-job-queue.ts:95 anchor re-read |
| AC-10 | MET | test | packages/db/tests/queue-job-lease.test.ts passes within gate suite; queue-job-dao.ts:223 anchor re-read |
| AC-11 | MET | test | dual-workflow-engine run-lifecycle/persistence tests pass within gate suite; events.ts:133 stale-owner event anchor re-read |
| AC-12 | MET | test | packages/ai-runner/tests/decision/driver-resolution-errors.test.ts passes this turn (construction errors not mislabeled) |
| AC-13 | MET | test | lease-consumer.test.ts stolen-attempt case passes within gate suite; db-job-queue.ts:449 `!applied` anchor re-read |
| AC-14 | MET | test | host.test.ts timeout cases pass within gate suite; host.ts:270/:209/:171 anchors re-read |
| AC-15 | MET | test | fm-process.test.ts timeout cases pass within gate suite; fm-process.ts:74/:98/:151 anchors re-read |
| AC-16 | MET | test | process-executor.test.ts split multi-byte UTF-8 case passes within gate suite; :957 TextDecoder anchor re-read |
| AC-17 | MET | test | process-executor.test.ts `expect(spans).toEqual([])` passes within gate suite; :431 removal comment re-read |
| AC-18 | MET | test | shims.test.ts hostile sessionId rejection cases pass within gate suite; shims.ts:463 anchor re-read |
| AC-19 | MET | test | fixers.test.ts symlink/dot-dot cases pass within gate suite; fixers.ts:163 anchor re-read |
| AC-20 | MET | test | api-client.test.ts bounded-body/URL cases pass within gate suite; api-client.ts:79/:262/:318 anchors re-read |
| AC-21 | MET | command | `rg -n "ts-decision-fm\|ts-laya-mlx" AGENTS.md` matches :20-21; `rg -n "laya-mlx (ADR-027" docs/03_ARCHITECTURE.md` matches :116 — both executed this turn |
| AC-22 | MET | command | `rg -n "R18 (MAY): DEFERRED" docs/tasks/0086_*.md` matches Solution:671; `rg -n "removal plan" packages/runtime/README.md` matches :644 — executed this turn |
| AC-23 | MET | command | `rg -n "R19 (MAY): DEFERRED" docs/tasks/0086_*.md` matches Solution:672 — executed this turn |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

# Review (stage: review, adversarial-reviewer, 2026-09-23)

# Review — task 0086, lap 2 (stage: review, adversarial-reviewer, 2026-09-23)

Post-remediation delta confirmation. Lap-1 verdict was request-changes (1×P1 + 4×P3/advisory). This lap verifies the fix closed the P1 and introduces no new defect; lap-1 P3s remain notes unless regressed.

**Verdict: approve** — lap-1 P1 is closed; no P0/P1 found in the delta; lap-1 P3 advisories unchanged.

## Priority findings (lap 1 + lap 2)

| id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| lap1-1 | P1 | argv/shell form predicate disagreement: `args: []` raw-substitutes template values into `/bin/sh -c` (injection bypass of the M1 fix) | variables.ts:104 vs host.ts:169 — CLOSED by attempt-2 fix (predicate alignment at variables.ts:106 + regression tests shell-template-security.test.ts:278/:324, 12/12 pass) |
| lap2-1 | P3 | Non-array `args` silently downgrades to shell form (injection-safe; fails open on form selection only, not on injection) | variables.ts:104 — advisory, owner: human |
| lap1-2 | P3 | Reserved `${__WF_n}` namespace collisions: author-literal `${__WF_0}` aliases the first bound var | variables.ts:82,114 — advisory note |
| lap1-3 | P3 | Containment degrades silently when an injected FileSystem lacks `realPath` | fixers.ts:161 — advisory note, fail closed instead |
| lap1-4 | P3 | Redaction key-anchor gaps outside the spec'd set | redaction.ts:51 — note |
| lap1-5 | P3 | Guard env asymmetry: guards/conditions resolve with `env: {}` so `${env.X}` throws there but resolves in actions | all three guard call sites — pre-existing, conscious choice |
| lap2-2 | P3 | No repo test drives a shell guard with `args: []` end-to-end | probe-confirmed safe (shared spawnShellCommand path with action runner) — test-gap note |

## Delta under review

- `packages/dual-workflow-engine/src/variables.ts:104`: argv predicate changed from `args !== undefined` to `Array.isArray(args) && args.length > 0`, with the producer/consumer invariant now documented in-source ("the predicates must agree or values would be raw-substituted into a shell line").
- `packages/dual-workflow-engine/tests/shell-template-security.test.ts` (new file — untracked, which is why it is invisible to `git diff 161f8672`; 12 tests total): the 2 lap-2 regression tests are `args: [] falls through to shell form: value rides as env, never executed (AC3)` and `args: [] failing command does not leak the resolved value in its error (AC4)`. Both run end-to-end through `StateMachineDriver` → real host → real `/bin/sh`.

## P1 closure — adversarial evidence (all executed against the worktree)

1. **Empty-array matrix.**
   - `args: []` → shell form with env binding: repo test proves the metachar value (`$(touch pwned-emptyargs); touch pwned-emptyargs2`) never executes, is delivered byte-for-byte to `out.txt`, and persisted options carry `${__WF_` placeholders without plaintext.
   - `args` omitted → shell form (existing repo tests).
   - `args: ['']` → **argv form on both sides**: producer takes `length > 0`; host `usesShell = explicitArgs.length === 0` is false → execFile. Probe: value `a; $(touch pwned)` created a file literally named `a; $(touch pwned)` with zero shell parsing, and `pwned` was never created.
2. **Metachar values riding env.** Backticks and `$()` delivered byte-for-byte, never executed (probe). Safe by construction: `sh -c` performs a single expansion pass, so bound values are never reparsed as shell syntax.
3. **Redaction on the shell-form error path.** Non-zero-exit error text is `Command "<bound command>" exited with N` (`host.ts` ShellActionRunner) — carries `${__WF_n}` placeholders only, never values (repo test 2 pins the `args: []` case; timeout probe: generic message, no command, no value). Validation errors expose nothing either: `args: [null]` → `WorkflowValidationError: Action option "args" must be a string array` with no command or value in the run result (probe).
4. **Persisted options.** The `__wfShellEnv` carrier is stripped at `action-step.ts:94` before `saveActionStart`; repo tests assert the persisted form (`${__WF_` present, plaintext absent) for the `args: []` case specifically. Guard options are never persisted.
5. **Predicate symmetry across call sites.** One producer (`resolveShellCommandTemplates`) at all four resolution points — `action-step.ts:90`, `state-machine.ts:240`, `transition-flow.ts:207`, `service.ts:350` — and one consumer (`spawnShellCommand`, `host.ts:167-171`) shared by `ShellActionRunner` and `ShellGuardRunner`. Guard `args: []` end-to-end probe: shell form + env binding, guard passes, no execution.
6. **Do the new tests actually pin the fix?** Mechanically yes. Reverting to `args !== undefined`: `args: []` takes the argv branch (raw substitution) while the host still selects `sh -c` (`explicitArgs.length === 0`) → `$(touch pwned-emptyargs)` executes → the test fails on the file-exists assertion, the `out.txt` content assertion, AND the persisted-plaintext assertion (triple-pinned). The leak test fails on the error text, which would inline the raw value.
7. **Runs.** Repo test file: 12/12 pass (37 assertions). Adversarial probes: 6/6 pass (`/tmp/0086-lap2-probe.test.ts` — scratch file outside the tree; worktree left pristine). Host-owned gate `0086-test-gate.log` PASS (2508 tests) not re-run.

## New findings (lap 2)

- **P3/advisory — non-array `args` silently downgrades to shell form** (`variables.ts:104` shell-form fallthrough drops the value via destructuring; host never sees it). `args: 'x'` / `args: null` now execute shell-form-with-binding instead of the pre-M1 `arrayOption` validation error. Injection-safe (probe: value rides env byte-for-byte, nothing executes), but an author typo in the `args` type silently changes the execution model without warning. Note only; tighten form-selection validation later if wanted.

## Lap-1 P3 advisories — not regressed, remain notes

Reserved `${__WF_n}` namespace collisions (`variables.ts:82,114`); `realPath` containment fallback (`fixers.ts:161`); redaction key-anchor gaps (`redaction.ts:51`); guard `env: {}` asymmetry (all three guard call sites). None are touched by the delta.

## Residual risks

- The silent shell-form downgrade for non-array `args` (new P3 above) is the only behavior change worth human awareness; it fails open on form selection but fails closed on injection.
- Minor test gap: no repo test drives a shell *guard* with `args: []` end-to-end (probe-confirmed safe; path is shared with the action runner).

— adversarial-reviewer, lap 2, 2026-09-23. Lap-1 verdict superseded; full lap-1 record and code anchors kept below.


---

#### Lap 1 record (2026-09-23, verdict superseded by lap 2; findings and anchors remain the durable reference)

**Verdict: request-changes** — one P1 must block verify; all else advisory.

## Findings

- **P1 — `args: []` injection bypass of the M1 fix.** `variables.ts:104` takes the argv branch on `args !== undefined` (raw substitution, no `__wfShellEnv`), while `host.ts:169` runs shell form on `args.length === 0` (`/bin/sh -c`). A shell action/guard with `command: 'echo ${vars.msg}', args: []` and a metachar-laden var is raw-substituted into `sh -c` — command substitution executes. Violates R3's own "non-empty array" rule; zero tests cover `args: []` (why the gate is green). Fix: one-line predicate alignment in `variables.ts:104` (`Array.isArray(args) && args.length > 0`) + regression test. Applies to actions and all three guard/condition call sites.
- **P3 — reserved `${__WF_n}` namespace collisions** (`variables.ts:82,114`): author-literal `${__WF_0}` aliases to the first bound var; unbound literals expand to empty in shell form but throw in argv form. Advisory.
- **P3 — containment degrades silently** when an injected `FileSystem` lacks `realPath` (`fixers.ts:161`, `fs.realPath?.(p) ?? p` falls back to plain path math). In-repo FS safe; fail closed instead. Advisory.
- **P3 — redaction key-anchor gaps** outside the spec'd set (`redaction.ts:51`): prefixed keys like `x-api-key` rely on shape rules; arbitrary values under them persist. Note.
- **P3 — guard env asymmetry** (pre-existing): guards/conditions resolve with `env: {}`, so `${env.X}` throws there but resolves in actions. Conscious-choice note.

## Per-dimension

- **Traceability**: R1–R17 implemented and verified; **R18/R19 deferrals verified honest** (identity.ts:102 default still present + README removal plan; Solution + CHANGELOG record R19 rationale) — AC22/AC23 satisfied via "Or" branches. R20 docs fixed (AGENTS.md:20-21, ARCHITECTURE heading, ADR-025 addendum). AC evidence present across 20 modified + 2 new test files; gap: no `args: []` case.
- **SECUA**: Security = F-1 only material issue; 13 attack scenarios constructed — injection via guards/conditions/values/single-quotes, redaction bypass, lease double-execution/zombie-writer, attempts-accounting, stale-owner completion, UTF-8 chunk split, path traversal (incl. macOS /etc aliasing), fm argv/sessionId abuse, API error/URL abuse, processOnce loop abuse — all blocked except F-1. Efficiency/correctness/usability/architecture clean: attempts boundary consistent across reclaim/failOrRetry/age-sweep; fenced acks gated; strict `applied === false` keeps legacy adapters; no new deps; drizzle confined to ts-db.

## Gate

`0086-test-gate.log` PASS (2/2 rules). Dynamic probe of the F-1 chain was cancelled by operator; the bypass is fully constructible from static code (predicates at variables.ts:104 vs host.ts:169).

### References

**Source review:** `/sp:dev-review packages --agent inline --focus all`, 2026-09-23, HEAD `d3e92081`. Findings came from the inline session; this task is their durable record.

**Code anchors (HEAD `d3e92081`):**

| Id | Anchor |
|----|--------|
| C1/M1/m3 | `packages/dual-workflow-engine/src/host.ts:146-200` (both shell runners), `:175` (error text) |
| M1 | `packages/dual-workflow-engine/src/variables.ts:4` (`TEMPLATE_REF`), `:23` (`mergeSetVars`), `:52-70` (`resolveTemplateString`) |
| M1 | `packages/dual-workflow-engine/src/action-step.ts:75-80` (resolve + `saveActionStart`) |
| M1 | `packages/dual-workflow-engine/src/state-machine.ts:235`, `transition-flow.ts:203`, `service.ts:347` (guard/condition resolution) |
| M1 | `.spur/workflows/feature-verification.yaml:40-60` (existing env-var idiom `"$featureId"`, `"$__runId"`) |
| M1 | `packages/dual-workflow-engine/src/persistence.ts:36-50` (`defaultActionRedactor`) |
| M2/m2 | `packages/infra/src/job-queue/db-job-queue.ts:95-105` (config defaults), `:128-197` (start/stop), `:210-236` (`processOnce`), `:340-372` (settlement), `:415-452` (`failOrRetry`) |
| M3 | `packages/db/src/queue-job-dao.ts:215-255` (`claimReady`), `:298-316` (`markFailed`), `:374-386` (`resetStuckJobs`); `packages/db/src/schema/queue-jobs.ts:8-30` |
| M4 | `packages/llm-jsonl-importer/src/redaction.ts:4-51` |
| M5/m4 | `packages/decision-fm/src/fm-process.ts:22-47` (argv), `:70-109` (probe/count), `:120-132` (respond timeout) |
| M5/m7 | `packages/ai-runner/src/agents/shims.ts:450-471` (fm shim) |
| M6 | `packages/dual-workflow-engine/src/persistence.ts:103-110` (Db `finalizeRun`), `:113-145` (claim/interrupt), `:398-401` (Memory `finalizeRun`) |
| M6 | `packages/dual-workflow-engine/src/types.ts:335` (interface), `run-lifecycle.ts:140-160, 223, 312, 328, 360`, `service.ts:180-215`, `events.ts:124-140` |
| m1 | `packages/ai-runner/src/decision/decision-maker.ts:84-120` |
| m5/m6 | `packages/runtime/src/process-executor.ts:431` (empty span), `:947-971` (`observeOutput`/`asString`), `:60-72` (`envMode`/`timeout` contract) |
| m7 | `packages/ai-runner/src/agent-spec.ts:30-42` (`ValueError`, `validateAgentId` pattern) |
| m8 | `packages/rule-engine/src/fixers/fixers.ts:115-124` (write/delete), `:159-162` (`isInsideWorkdir`); `packages/runtime/src/fs.ts:61-95` (ADR-022 realPath walk); `packages/runtime/src/file-system.ts:75` (`realPath?`) |
| m9 | `packages/infra/src/api-client.ts:68` (`APIError`), `:197` (`observableUrl`), `:248-256` (timeout), `:300-309` (non-OK body) |
| C2 | `packages/runtime/src/process-executor.ts:668-729` (deprecated surface); `packages/ai-runner/src/identity.ts:2, 98-102` |
| C3 | `packages/runtime/src/process-executor.ts:~771-929` (process-group containment) |
| D1 | `docs/03_ARCHITECTURE.md:116`; `AGENTS.md` package table |

**ADRs:**
- ADR-002/003: `workspace:*`.
- ADR-005: drizzle inside ts-db.
- ADR-011/014: platform seams.
- ADR-020: atomic transition persistence (`docs/00_ADR.md:296`).
- ADR-022: symlink-safe confinement (`:319`).
- ADR-025: run interruption and ownership (`:403`); M6 addendum target.
- ADR-027/028: laya-mlx and one-way backend selection (`:477`, `:507`).
- ADR-029/030/031: fm backend (`:524-558`).

**Process docs:** `docs/99_PROJECT_CONSTITUTION.md`, `docs/PACKAGE_RELEASE.md:32-38` (CHANGELOG folding), root `AGENTS.md` (verification gate).

**Prior art:** task 0060 (2026-08-12 review remediation; same format; introduced `defaultActionRedactor` and the `envMode` contract). Task 0061.

**External:** Swift ArgumentParser treats a token starting with `-` as an option unless it follows `--`. Verified live against `/usr/bin/fm` (see Background).

### History

- 2026-09-23T23:34:08.552Z backlog → todo (system)
- 2026-09-24T00:47:29.347Z todo → wip (system)
- 2026-09-24T02:54:22.436Z wip → testing (system)
- 2026-09-24T02:58:49.986Z testing → done (system)

