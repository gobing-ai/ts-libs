---
schema_version: 1
name: Burn down 0086 review advisories and MAY deferrals (R18/R19)
status: done
template: feature-impl
created_at: 2026-09-24T03:34:54.620Z
updated_at: "2026-09-24T05:08:47.129Z"
feature_id: L

---

## 0087. Burn down 0086 review advisories and MAY deferrals (R18/R19)

### Background

Captured from the creation title: "Burn down 0086 review advisories and MAY deferrals (R18/R19)".

### Requirements

R1: `resolveShellCommandTemplates` (`packages/dual-workflow-engine/src/variables.ts:104-112`) must fail closed on a defined non-array `args` (`args: 'x'`, `args: null`, `args: 5`): throw a validation error naming the expected type. Silent shell-form downgrade is forbidden. `args: undefined` and `args: []` keep current behavior (shell form); non-empty arrays keep argv form.
R2: The reserved `${__WF_n}` placeholder namespace must be collision-proof. Authored shell command text containing a `${__WF_<digits>}` literal when no binding pass produced it (no `SHELL_ENV_OPTION` on the options) must raise a validation error naming the reserved namespace. Re-resolution of already-bound options (SHELL_ENV_OPTION present) stays idempotent.
R3: `isInsideWorkdir` (`packages/rule-engine/src/fixers/fixers.ts:161`) must fail closed when the injected `FileSystem` lacks `realPath`: return false (refuse the fix) instead of silently using the unresolved path. Existing realPath behavior unchanged.
R4: `SECRET_KEY` (`packages/llm-jsonl-importer/src/redaction.ts:51`) gains the anchored keys `api_secret`, `auth_token`, `secret_key`, `private_key`, `session_token`. Usage-analytics keys (`token_count`, `max_tokens`, `tokens_used`, `token_usage`) must remain unredacted.
R5: Guard/condition template resolution receives the same env map as actions: the three call sites `service.ts:350`, `state-machine.ts:240`, `transition-flow.ts:207` thread the run's env instead of `env: {}`, so `${env.X}` resolves identically in guards and actions.
R6: Add a repo end-to-end test driving a shell guard with `args: []`: metachar var rides env binding (no execution, no sentinel file), guard result is correct, and the test fails if the binding predicate is bypassed (mutation-verified).
R7: Migrate `identity.ts` sync git-context path off the deprecated `BunSyncProcessExecutor`: add a non-deprecated `NodeSyncProcessExecutor` (node:child_process spawnSync, runtime's owning adapter seam) exported from ts-runtime, and change `getGitContextSync`'s default to it. `SyncProcessExecutor` type widens to an interface both executors satisfy. `BunSyncProcessExecutor` stays exported-deprecated (removal in next major per the recorded plan). runtime/README deprecation note updated to "migrated; removal pending".
R8: Extract the process-group containment block (`packages/runtime/src/process-executor.ts` ~771-929) into `packages/runtime/src/process-group.ts` as a pure move: same exports reachable through the same public paths, no behavior change, all runtime tests pass unmodified. runtime/README + docs/03_ARCHITECTURE.md updated if they reference the block's location.
R9: Process gate: CHANGELOG.md `## [Unreleased]` → `### Fixed` gains entries for R1-R8; `bun run spur-check` and `bun run build` exit 0.

### Acceptance Criteria

Each scenario maps to one requirement via `(req: R<n>)`. Every scenario must be backed by an executable test or command named in Testing.

```gherkin
Feature: 0086 review advisories and MAY deferrals are burned down

  Scenario: AC1 — Non-array shell args fail closed (req: R1)
    Given a shell action with args set to a string, null, or a number
    When the workflow runs
    Then a validation error naming the args type is raised and nothing executes
    And args omitted and args: [] still run shell form, non-empty args still run argv form

  Scenario: AC2 — Reserved placeholder namespace is collision-proof (req: R2)
    Given an authored shell command containing the literal text "${__WF_0}" without prior binding
    When templates resolve
    Then a validation error naming the reserved namespace is raised
    And re-resolving already-bound options (SHELL_ENV_OPTION present) stays idempotent

  Scenario: AC3 — Containment fails closed without realPath (req: R3)
    Given a FileSystem without realPath and a fix path under a symlinked parent
    When the fixer checks containment
    Then the fix is refused (isInsideWorkdir returns false)

  Scenario: AC4 — Extended secret keys redact, analytics keys survive (req: R4)
    Given JSON with api_secret, auth_token, secret_key, private_key, session_token string values
    And JSON with token_count, max_tokens, tokens_used, token_usage values
    When redactValue runs with DEFAULT_REDACTION_RULES
    Then the five secret keys are redacted and the four analytics keys are untouched

  Scenario: AC5 — Guards resolve env identically to actions (req: R5)
    Given env MARKER=known-value and a guard command referencing "${env.MARKER}"
    When the guard evaluates
    Then it sees "known-value" exactly as an action would
    And service.ts, state-machine.ts and transition-flow.ts no longer pass env: {}

  Scenario: AC6 — Shell guard with args: [] is env-bound end to end (req: R6)
    Given a shell guard with args: [] and a metachar var
    When the guard runs
    Then the value rides the env binding, no command substitution executes, and the boolean result is correct
    And the test fails if the binding predicate is reverted (mutation check)

  Scenario: AC7 — Sync git context off the deprecated executor (req: R7)
    Given identity.ts
    Then getGitContextSync's default executor is NodeSyncProcessExecutor, not BunSyncProcessExecutor
    And getGitContextSync keeps working (injected-executor test passes)
    And packages/runtime/README.md deprecation note says the default was migrated

  Scenario: AC8 — Process-group block extracted as a pure move (req: R8)
    Given packages/runtime/src/process-group.ts holds the extracted containment code
    Then process-executor.ts consumes it and all pre-existing runtime tests pass unmodified
    And the public API surface is unchanged (tsc --noEmit clean, exports resolve)

  Scenario: AC9 — Gates green (req: R9)
    When "bun run spur-check" and "bun run build" run from the repo root
    Then both exit 0
    And CHANGELOG.md has an "## [Unreleased]" "### Fixed" entry for R1-R8
```

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

<!-- Chosen implementation approach, key tradeoffs, invariants, and impacted surfaces. -->

### Plan

<!-- Ordered implementation checklist. Fill before moving to todo/wip. -->

### Solution

All nine requirements implemented on branch `sp/task-0087`:

- **R1:** `resolveShellCommandTemplates` throws `shell action "args" must be a string array when defined` for a defined non-array `args` (variables.ts); `undefined`/`[]` keep shell form, non-empty arrays keep argv form.
- **R2:** reserved-namespace guard — authored shell command text containing a `${__WF_n}` literal without a prior binding pass (no `SHELL_ENV_OPTION` on the options) throws; re-resolution of bound options stays idempotent (variables.ts, `SHELL_BINDING_ANY`).
- **R3:** `isInsideWorkdir` returns false (refuses the fix) when the injected `FileSystem` lacks `realPath` — fail closed instead of silent degradation (fixers.ts).
- **R4:** `SECRET_KEY` extended with `api_secret`, `auth_token`, `secret_key`, `private_key`, `session_token`; anchored anchors keep `token_count`/`max_tokens`/`tokens_used`/`token_usage` unredacted (redaction.ts).
- **R5:** `GuardContext` gains `env?`; both drivers thread the run's allowed-env map into guard/condition resolution; `service.requestTransition` computes `allowedEnv(workflow.env?.allow ?? [], options?.env)` and threads it into both resolution and the guard context (types.ts, state-machine.ts, transition-flow.ts, service.ts).
- **R6:** new e2e test — shell guard with `args: []` runs shell form with env binding (no sentinel, byte-exact value); predicate revert is caught by the suite (mutation-checked: R1 test fails).
- **R7:** new `NodeSyncProcessExecutor` (node `spawnSync`, runtime adapter seam) exported from ts-runtime; `SyncProcessExecutor` widened to an interface both sync executors satisfy; `getGitContextSync` defaults to it (identity.ts); runtime README deprecation note updated.
- **R8:** process-group containment block extracted to `packages/runtime/src/process-group.ts` (pure move; `process-executor.ts` imports `ownProcessGroupLifecycle`/`ProcessGroupOwnership`/`resolveDeadline`/`resolveKillGraceMs` back); public API unchanged.
- **R9:** CHANGELOG `## [Unreleased]` → `### Fixed` entries for R1-R8; `bun run spur-check` exit 0; `bun run build` exit 0.

Anchors: `variables.ts:113` (R1 throw), `variables.ts:85` (R2 SHELL_BINDING_ANY), `fixers.ts:161` (R3 fail-closed), `redaction.ts:52` (R4 extended SECRET_KEY), `types.ts:199` (R5 GuardContext.env), `process-executor.ts:735` (R7 NodeSyncProcessExecutor), `identity.ts:103` (R7 default), `process-group.ts:1` (R8 extraction).

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | variables.ts:113 throws on defined non-array args; shell-template-security.test.ts R1 test covers string/null/number rejection plus args-omitted/[]/non-empty behavior |
| R2 | MET | variables.ts:85 SHELL_BINDING_ANY (braced + unbraced); namespace throw at :128-133; re-resolution seeds env/index from existing bindings (:136-141); tests assert command AND env-map parity |
| R3 | MET | fixers.ts:161-163 returns false when fs.realPath is undefined; fixers.test.ts Proxy-based test confirms refusal + untouched file |
| R4 | MET | redaction.ts:52 extended anchored SECRET_KEY; redaction.test.ts: five extended keys redact, four analytics keys untouched |
| R5 | MET | types.ts:199 GuardContext.env; state-machine.ts/transition-flow.ts guard context builds pass the driver env; service.ts:342-345 computes allowedEnv(workflow.env?.allow ?? [], options?.env) and threads it into resolution + evaluateGuardResult; e2e test: guard sees MARKER=known-value |
| R6 | MET | shell-template-security.test.ts R6 test: guard with args: [] runs shell form, env-bound, no sentinel, byte-exact value; predicate revert caught (mutation check: R1 test fails) |
| R7 | MET | process-executor.ts:735 NodeSyncProcessExecutor (node spawnSync); index.ts re-exports it + SyncProcessExecutor interface; identity.ts:103 default; identity.test.ts default-executor test resolves the real repo; runtime process-executor.test.ts: 3 NodeSync tests |
| R8 | MET | process-group.ts holds the extracted block (ownProcessGroupLifecycle, ProcessGroupOwnership, resolveDeadline, resolveKillGraceMs exported); process-executor.ts imports them; process-group.test.ts covers validators + a real detached-group reap (Unix); all 253 pre-existing runtime tests pass unmodified |
| R9 | MET | CHANGELOG.md Unreleased→Fixed has 0087 entries; bun run spur-check exit 0 (2524 tests, All 2 rules passed) and bun run build exit 0, both run this turn |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC-1 | MET | test | shell-template-security.test.ts R1 test (4 assertions over bad/good args shapes), 17/17 file tests pass |
| AC-2 | MET | test | shell-template-security.test.ts R2 tests: braced + unbraced literals throw; idempotent re-resolution asserts command and env-map equality |
| AC-3 | MET | test | fixers.test.ts "containment fail-closed" — realPath-less FileSystem defers the fix, file untouched |
| AC-4 | MET | test | redaction.test.ts "SECRET_KEY extended anchors" — 5 secret keys redact, 4 analytics keys untouched |
| AC-5 | MET | test | shell-template-security.test.ts R5 test: guard resolves env.MARKER to known-value; grep confirms no `env: {}` remains at the three call sites |
| AC-6 | MET | test | shell-template-security.test.ts R6 test passes; mutation check (predicate revert) fails the suite |
| AC-7 | MET | test | identity.test.ts default-executor test passes against the real repo; NodeSyncProcessExecutor unit tests pass (3) |
| AC-8 | MET | test | process-group.test.ts 4/4 pass incl. real group reap; runtime suite 253 pre-existing tests unmodified and passing; tsc --noEmit clean |
| AC-9 | MET | command | `bun run spur-check` exit 0 and `bun run build` exit 0 executed this turn; CHANGELOG Fixed entries present |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

**Verdict: approve** (adversarial review, fresh executor; no P0/P1 blockers)

Full report: `.spur/run/0087-review-answer.txt`. Probes: re-resolution/smuggle/unbraced scenarios reproduced via bun against `variables.ts`; spawn-failure divergence verified (Bun throws, node returns exitCode 1); pure-move diff clean; targeted tests 47 pass / 0 fail (shell-template-security, fixers, redaction, process-group, identity).

| id | Severity (P1–P4) | Finding | Evidence |
|----|------------------|---------|----------|
| ADV-1 | P2 | R2 re-resolution drops the `__wfShellEnv` binding map while command keeps `${__WF_n}` refs — NOT idempotent as spec/comments claim. Shell then expands placeholders from ambient process env. Latent: no current caller re-resolves. One-line fix: seed env/index from existing SHELL_ENV_OPTION; test asserts command only, never the env map. | Probe: once `{__wfShellEnv:{__WF_0:"SECRET;id"}}` → twice `{__wfShellEnv:{}}`, command unchanged. variables.ts:118-140; shell-template-security.test.ts:377-381,418-422 |
| ADV-2 | P3 | R2 guard `!(SHELL_ENV_OPTION in options)` cannot distinguish re-resolution from authored input: authoring `__wfShellEnv` in options bypasses the namespace check (authored `${__WF_0}` aliases first bound value) and injects arbitrary env into the spawned shell, bypassing the R5 `env.allow` list. Author-domain, but defeats fail-closed for definitions assembled from untrusted fragments. | Probe: `{command:'echo ${__WF_0} ${vars.x}', __wfShellEnv:{}}` resolves without throw, alias confirmed. variables.ts:128 |
| ADV-3 | P4 | Reserved-namespace guard matches only braced `${__WF_n}`; shell-equivalent unbraced `$__WF_0` evades both the guard and binding pass — silent collision remains possible. Low likelihood (obscure name). | Probe: `echo $__WF_0 ${vars.x}` → `$__WF_0 ${__WF_0}` + binding minted, no throw. variables.ts:97,128 |
| ADV-4 | P4 | R7 parity claim inaccurate on spawn failure: BunSyncProcessExecutor throws on ENOENT (verified), NodeSync returns exitCode 1 — JSDoc says same shape. Improvement for identity.ts (null vs throw), behavior change for other migrators. Also node spawnSync 1MB default maxBuffer silently yields exitCode 1 on huge `git status` output. | /tmp probe: "bun THROWS: Executable not found" vs "node status= undefined". process-executor.ts NodeSyncProcessExecutor |
| ADV-5 | P4 | R3 fail-closed makes fixes 100% inert on FileSystem impls without realPath: `createCfFileSystem()` has none → every fix deferred/skipped under a CF host. Intended fail-closed and observable via deferred list, but total availability regression for that mode. Node default unaffected. | file-system-cf.ts:28 (no realPath) vs file-system-node.ts:116; fixers.ts:87-89,163,214 |

Verified clean: R5 env threading parity (state-machine.ts:65, transition-flow.ts:64, service.ts:342 — same allowedEnv helper); R7 identity test not branch-coupled (`/branch: \S+/` on real repo); R7 rejectOnError/stripFinalNewline/env/cwd byte-identical; R8 pure move identical modulo export modifiers, type-only circular import erased, index API additive-only; R1 fail-closed incl. `args: null`; R4 anchored SECRET_KEY — no new analytics false positives.

**Residual risks:** ADV-1 is one refactor away from live (any retry wrapper/custom host that re-resolves options silently loses bindings → ambient-env expansion); recommend the seeding fix + env-map assertion. Loaders merging untrusted option fragments should strip `__wfShellEnv` before resolution (ADV-2).

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-09-24T05:08:47.129Z backlog → done (system)

