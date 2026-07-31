---
schema_version: 1
name: "Migration parity gaps: ai-runner vs spur-old kernel ai-runner"
status: done
type: task
priority: P1
tags: [migration,review,ai-runner,parity]
created_at: 2026-06-05T00:59:54.894Z
updated_at: 2026-06-05T01:18:11.232Z
---

## 0016. "Migration parity gaps: ai-runner vs spur-old kernel ai-runner"

### Background

Comparative code review of the migrated packages/ai-runner against its origin at ~/xprojects/spur-old/packages/kernel/src/ai-runner. The migration rewrote 6 overlapping files (1093 LOC original) and added 5 net-new team-mode files. The overlapping files shrank ~40%, and that shrinkage silently dropped real, intentional behavior — primarily in auth detection and version detection. This task captures every gap with full before/after detail so fixes proceed without drift. The 5 new team-mode files have no original to regress against and are out of scope here.


### Requirements

## Requirements

Verification of the 11 parity findings (see Review section). Verdict per finding with implementation + test evidence. Run via `/rd3:dev-verify 0016 --auto --fix all --force` on 2026-06-04.

- [x] **F1 — Auth output-pattern probing restored** → **MET** | Evidence: `doctor-runner.ts:39-61` (`AUTH_PATTERNS` per-agent positive/negative table) + `doctor-runner.ts:151-161` (`probeAuthOutput` → `boolean|null`, non-zero exit→false, negative→false, positive→true, else null). Tests: `doctor-runner.test.ts:111` (claude exit-0 `loggedIn:false` → unauthenticated), `:126` (openclaw `unhealthy` → unauthenticated), `:140` (claude `loggedIn:true` → authenticated). ADR-011-clean (injected `fs`/`env`, no `node:fs`).
- [x] **F2 — Codex CLI-first + both file paths** → **MET** | Evidence: `doctor-runner.ts:134-141` (`checkCodexAuth`: `probeAuthOutput('codex')` first; on `null` falls back to `.codex/auth.json` ‖ `.codex/auth`). Tests: `:166` (CLI "Not logged in" overrides stale `auth.json`), `:186` (no-extension `auth` fallback honored).
- [x] **F3 — Version string = full first line** → **MET** | Evidence: `agent-detector.ts:75` (`output.split('\n')[0]?.trim() || match.groups.version`). Test: `agent-detector.test.ts:87` asserts `version: 'pi 1.2'` (full line preserved, not bare token). _Minor test gap: no case with a descriptive suffix like `"2.1.129 (Claude Code)"`; the prefix case proves the mechanism. Optional hardening, not blocking._
- [x] **F4 — runSlashCommand + buildPromptCommand re-added** → **MET** (decision: re-added) | Evidence: `ai-runner.ts:70-77` (`runSlashCommand` translates then dispatches), `:79-82` (`buildPromptCommand` builds without executing, with identity-preamble enrichment). Reachable via `export *` from `index.ts`. Tests: `ai-runner.test.ts:57` (codex translation before dispatch), `:68` (build returns ShimCommand without invoking executor).
- [x] **F5 — Gemini content-check** → **MET** | Evidence: `doctor-runner.ts:143-149` (`geminiSettingsContainCredentials` reads settings via injected `fs`, applies `/auth|token|key/i`, try/catch→false). Test: `:198` (prefs-only `{"theme":"dark"}` → false; `{"token":"live"}` → true).
- [x] **F6 — 2-part version regex** → **MET** (decision: kept + documented) | Evidence: `agent-detector.ts:27` retains `\d+\.\d+(?:\.\d+)?`. Test: `agent-detector.test.ts:87` "preserves the intentional 2-part version parse" pins the lenient semantics deliberately.
- [x] **F7 — Structured logging** → **MET** (decision: operator chose "Add ts-infra logger now") | Evidence: new `@gobing-ai/ts-infra` dependency wired per ADR-002 (`package.json` `workspace:*`) + ADR-004 (`tsconfig.json` path alias `../infra/src/index`). `AiRunner` injects `getLogger('ai-runner')` (constructor-overridable `logger` option): `ai-runner.ts` logs `debug` per invoke with `{label, command, args}` and `error` on non-zero exit with `{label, exitCode, signal}`. `DoctorRunner` injects `getLogger('doctor')`, logs `debug` per agent check. No cycle (ai-runner→ts-infra→ts-db→ts-runtime is a DAG). Test: `ai-runner.test.ts` "logs invocation diagnostics and escalates a non-zero exit to error" (injects a recording Logger, asserts `debug 'invoke'` + `error 'invoke exited non-zero'`). Both files retain 100% line coverage.
- [x] **F8 — Distinct detector error messages** → **MET** | Evidence: `agent-detector.ts:61-66` (separate branches: `Terminated by signal: X` / `Process did not produce an exit code` — misleading "timed out" removed; non-zero exit retains code + stderr slice). Test: `agent-detector.test.ts:97` asserts distinct signal vs null-exit error strings.
- [x] **F9 — detectChannels seam restored** → **MET** | Evidence: `agent-detector.ts:84+` (`detectChannels(agent, output): string[]` private method returning `[]` with Phase-2 roadmap comment). `parseResult` calls it at `:78` (`channels: this.detectChannels(...)`).
- [x] **F10 — runAll defensive synthesis** → **MET** | Evidence: `doctor-runner.ts:84-100` (`runAll` maps `DISPLAY_ORDER`, synthesizes `Unknown agent: <name>` for any name the detector omits). Test: `doctor-runner.test.ts:225` (detector returns only claude → result still has `DISPLAY_ORDER.length` rows, codex synthesized as unavailable).
- [x] **F11 — Re-export surface** → **MET** | Evidence: `index.ts` uses `export *` across all modules; re-added F4 methods and F9 seam reachable. Verified: 66 ai-runner tests import/exercise the public surface without missing-export errors.

### Verdict: **PASS** (11 / 11 met)

All 11 parity findings resolved. Every P1/P2 correctness regression (F1, F2, F3, F5) and every decision-gated item (F4, F6, F7) is implemented with a regression test that encodes WHY the behavior matters. F7 was resolved in the fix pass after the operator chose to add the ts-infra logger.

**Gate (final):** `bun run spur-check` → PASS (1110 tests, 0 fail; all 34 spur rules pass incl. corrected `runtime-boundaries` and the ADR-002/004 dependency-pairing rules for the new ts-infra edge; `ai-runner.ts` + `doctor-runner.ts` at 100% line coverage). `bun run build` → PASS (all 8 packages). `git status` → only intentional changes (3 src + 3 test files + `package.json` + `tsconfig.json` + `bun.lock` + this task).

**No remaining action.** Task complete.


### Q&A



### Design

- Scope: restore migration parity in `packages/ai-runner` without changing package boundaries or adding new dependencies.
- Key decisions:
  - Re-add `AiRunner.runSlashCommand` and `AiRunner.buildPromptCommand`; grep of `/Users/robin/xprojects/spur-old` showed both are used by the origin agent service and documented as frozen kernel API.
  - Keep the intentionally loosened two-part version parser and add a regression test pinning `1.2` as installed.
  - Restore structured logging (F7): operator approved adding the `@gobing-ai/ts-infra` dependency (wired per ADR-002 `workspace:*` + ADR-004 tsconfig path). `AiRunner`/`DoctorRunner` take an injectable `logger` defaulting to `getLogger('ai-runner')` / `getLogger('doctor')`. Dependency graph stays acyclic (ai-runner→ts-infra→ts-db→ts-runtime).
  - Reinstate the `detectChannels` extension seam returning `[]` so the public `channels` field keeps its planned enrichment hook.
  - Reinstate `DoctorRunner.runAll` fixed display-order synthesis so doctor output remains one row per known agent even if detector output changes.
- Boundaries affected: `packages/ai-runner/src/ai-runner.ts`, `packages/ai-runner/src/agent-detector.ts`, `packages/ai-runner/src/doctor-runner.ts`, and package-local tests.
- Risks: auth probing is string-pattern sensitive; regression tests pin the known false-positive and fallback cases from the parity review.


### Solution

- Restored per-agent auth probing with positive and negative regexes, including CLI-first codex auth and file fallback for both `~/.codex/auth.json` and `~/.codex/auth`.
- Restored Gemini credential content checking instead of treating any non-empty settings file as authenticated.
- Restored full first-line version display while keeping the current two-part semver parse gate.
- Restored distinct detector diagnostics for signal termination, null exit code, and non-zero exit.
- Re-added public prompt helpers `runSlashCommand` and `buildPromptCommand` with migrated names and identity-preamble behavior.
- Restored the detector channel extension seam and doctor fixed display-order synthesis.
- Added regression tests for auth false positives, codex fallback ordering, Gemini credential detection, version display/2-part parsing, detector diagnostics, runner public helpers, and doctor row synthesis.


### Plan

- [x] Review task requirements, origin usage references, and existing ai-runner implementation/tests.
- [x] Implement auth parity fixes in `DoctorRunner`.
- [x] Implement detector version/error/channel parity fixes.
- [x] Restore dropped `AiRunner` public methods.
- [x] Add focused regression tests for each restored behavior or recorded decision.
- [x] Run package and workspace verification gates.
- [x] Update task testing/review evidence and transition only after verification passes.


### Review

#### Verification — 2026-06-05

Verdict: PASS

- Requirements traceability: PASS. Findings 1, 2, 3, 4, 5, 6, 8, 9, 10, and 11 are restored in code with regression tests or explicitly recorded as decisions in `Design`.
- Correctness: PASS. Auth probing now requires positive signals, rejects known negative signals, keeps codex CLI authoritative over stale files, and checks Gemini credential content.
- Architecture/security: PASS. Changes stay inside `packages/ai-runner`, use `@gobing-ai/ts-runtime` file/path/process seams, and add no direct platform imports or new dependencies.
- Tests: PASS. `bun run spur-check` and `bun run build` passed.

## Review — Migration parity (2026-06-04)

**Status:** 10 findings (2 P1 · 4 P2 · 4 P3 · 1 P4)
**Scope:** `packages/ai-runner/src` (6 migrated files) vs `~/xprojects/spur-old/packages/kernel/src/ai-runner` (origin)
**Mode:** comparative migration review (manual, both trees read in full)
**Out of scope:** the 5 net-new team-mode files (`agent-spec`, `identity`, `message-service`, `team-agent-process`, `team-orchestrator`) — no original to compare.

### File map

| File | Original LOC | Migrated LOC | Status |
|------|-------------|--------------|--------|
| `agents/shims.ts` | 225 | 195 | parity (rename only) |
| `slash-command.ts` | 66 | 42 | parity (behavior identical) |
| `ai-runner.ts` | 213 | 134 | **2 public methods dropped** |
| `agent-detector.ts` | 237 | 84 | **version + error + channels regressed** |
| `doctor-runner.ts` | 329 | 121 | **auth detection gutted** |
| `index.ts` | 23 | 10 | re-export surface narrowed (follows above) |

### Naming map (intentional, applied consistently — NOT findings)

| Original | Migrated |
|----------|----------|
| `ExecResult` | `AgentRunResult` |
| `PromptOpts` | `PromptOptions` |
| `RunOpts` | `AgentRunOptions` |
| `ShimCmd { cmd, args }` | `ShimCommand { command, args }` |
| `CodingAgentShim` | `AgentShim` |
| `getShim` | `getAgentShim` |
| `run*Cmd` | `run*Command` |
| `runAuthCheckCmd` | `runAuthCommand` |
| `@spur/core` ProcessExecutor | `@gobing-ai/ts-runtime` NodeProcessExecutor |

Any fix below MUST use the migrated names, not the originals.

---

## P1 — Blockers (auth false positives)

### Finding 1 — All output-pattern auth probing was deleted → false-positive authentication

**Dimension:** Correctness
**Location:** `packages/ai-runner/src/doctor-runner.ts:87-113` (`checkAuth`)
**Origin:** `spur-old/.../doctor-runner.ts:188-328` (`checkAuth` + `probeAuthOutput` + 5 per-agent methods)

**What the original did.** Each agent had a dedicated auth strategy with BOTH a positive and a negative regex, evaluated against combined `stdout+stderr` via a shared `probeAuthOutput(agent, positive, negative)` helper. The negative pattern is the critical part — it catches "exit 0 but actually logged out":

- **claude** (`checkClaudeAuth`):
  - positive: `/authenticated|logged[\s_-]*in|"loggedIn"\s*:\s*true/i`
  - negative: `/not[\s_-]*authenticated|not[\s_-]*logged[\s_-]*in|logged[\s_-]*out|unauthenticated|"loggedIn"\s*:\s*false/i`
- **opencode** (`checkOpencodeAuth`):
  - positive: `/configured|available/i`
  - negative: `/not[\s_-]*configured|no[\s_-]+providers?[\s_-]+available|unavailable/i`
- **openclaw** (`checkOpenclawAuth`):
  - positive: `/(^|[^a-z])ok([^a-z]|$)|healthy/i`
  - negative: `/not[\s_-]*healthy|unhealthy|not[\s_-]*ok/i`
- `probeAuthOutput` semantics (origin :309-328): if `exitCode !== 0` → `false`; else if negative matches → `false`; else if positive matches → `true`; else → `null` (inconclusive). Codex used `null` to trigger its file fallback (see Finding 2).

**What the migration does instead (`doctor-runner.ts:106-112`).** One generic check for ALL CLI-probed agents:
```ts
const result = await command;
return (
    result.exitCode === 0 &&
    !/not authenticated|not logged|unauthenticated/i.test(`${result.stdout}\n${result.stderr}`)
);
```

**Why this is a P1 regression.**
1. **claude false positive:** `claude auth status` can exit 0 and print `"loggedIn": false`. The original caught this via `"loggedIn"\s*:\s*false`. The migrated negative regex does NOT include `loggedIn:false` or `logged out`, so it returns `true` → reports an unauthenticated agent as authenticated.
2. **Positive signal no longer required:** the original required a positive match to return `true`. The migration returns `true` for ANY exit-0 output that lacks the narrow negative phrase — e.g. a help text, an error unrelated to auth, an empty response.
3. **opencode/openclaw lost their tailored vocab** (`configured`, `healthy`, `unhealthy`, etc.). A `openclaw health` that prints `unhealthy` exits 0 → now reported authenticated.

**Fix.**
- Reintroduce a per-agent positive/negative pattern table and a `probeAuthOutput`-equivalent that returns `boolean | null` (`true` on positive, `false` on negative or non-zero exit, `null` inconclusive).
- Wire claude/opencode/openclaw through it with the exact regexes above.
- Keep the migrated `this.env` / `this.fs` injection seams (do NOT reintroduce `node:fs` `existsSync`/`readFileSync` directly — that violates ADR-011; use the injected `SyncFileSystem`/`FileSystem` already on the class).
- For pi, preserve env-var-first then CLI fallback (migration already does this; keep it).

**Regression test (encode WHY, not WHAT):**
- `doctor reports claude UNAUTHENTICATED when 'claude auth status' exits 0 with '{"loggedIn": false}'` → expect `authenticated === false`.
- `doctor reports openclaw UNAUTHENTICATED when 'openclaw health' exits 0 printing 'unhealthy'` → false.
- `doctor reports claude AUTHENTICATED when output contains '"loggedIn": true'` → true.
- `doctor reports inconclusive exit-0 output (no positive, no negative) as NOT authenticated` (decide: original returned null→false for claude; preserve false).

---

### Finding 2 — Codex auth regressed to file-only; CLI check and second file path dropped

**Dimension:** Correctness
**Location:** `packages/ai-runner/src/doctor-runner.ts:96-97`
**Origin:** `spur-old/.../doctor-runner.ts:226-237` (`checkCodexAuth`)

**What the original did.**
```ts
private async checkCodexAuth(): Promise<boolean> {
    const probeStatus = await this.probeAuthOutput(
        'codex',
        /logged[\s_-]*in|authenticated/i,
        /not[\s_-]*authenticated|not[\s_-]*logged[\s_-]*in|logged[\s_-]*out|unauthenticated/i,
    );
    if (probeStatus !== null) return probeStatus;          // CLI was conclusive → trust it
    const home = getEnvVar('HOME') ?? '';
    return existsSync(`${home}/.codex/auth.json`) || existsSync(`${home}/.codex/auth`);  // fallback
}
```
Order: **`codex login status` CLI FIRST**, fall back to file only when the CLI is inconclusive (`null`). Two file paths checked: `auth.json` AND extension-less `auth`.

**What the migration does (`doctor-runner.ts:96-97`).**
```ts
if (agent === 'codex' && (await this.hasNonEmptyFile(joinPath(home, '.codex', 'auth.json')))) return true;
// then falls through to the generic CLI check ONLY if the file is absent
```
- The CLI `codex login status` is no longer run first; the file is checked first.
- Only `auth.json` is checked; the extension-less `~/.codex/auth` variant is gone.
- If the file exists but is empty, `hasNonEmptyFile` returns false and it falls through to the generic check — partially OK, but inverts the original's CLI-authoritative order.

**Why it matters.**
- **False positive:** a stale `~/.codex/auth.json` (logged out but file lingers) → reported authenticated. Original would have run `codex login status`, seen `logged out`, and returned false.
- **False negative:** a valid codex session whose credentials live in `~/.codex/auth` (no extension) → file check misses it, then the generic CLI check must save it. Fragile.

**Fix.** Restore CLI-first order: run `codex login status` via `probeAuthOutput` (positive `/logged[\s_-]*in|authenticated/i`, negative `/not[\s_-]*authenticated|not[\s_-]*logged[\s_-]*in|logged[\s_-]*out|unauthenticated/i`); only on `null` fall back to checking `~/.codex/auth.json` OR `~/.codex/auth` (both, via injected `fs`).

**Regression test:**
- `codex reports UNAUTHENTICATED when 'codex login status' prints 'Not logged in' even if ~/.codex/auth.json exists` → false (proves CLI is authoritative over stale file).
- `codex falls back to ~/.codex/auth (no extension) when login status is inconclusive and auth.json is absent` → true.

---

## P2 — Warnings

### Finding 3 — Version string semantics changed (full first line → bare semver token)

**Dimension:** Usability
**Location:** `packages/ai-runner/src/agent-detector.ts:67-74`
**Origin:** `spur-old/.../agent-detector.ts:199-219`

**Original:** `const version = combinedOutput.split('\n')[0] || match.groups.version;` — returns the **full first line** (e.g. `"2.1.129 (Claude Code)"`), explicitly documented as "matching the reference airunner display format" (origin :211-213, and `doctor-runner.ts:29` shows `version: '2.1.129 (Claude Code)'`).

**Migrated:** `version: match.groups.version` — returns only the captured semver token (`"2.1.129"`). The descriptive suffix is lost.

**Why it matters.** User-visible output regression for any `doctor`/list display in spur. The DetectedAgent/DoctorResult `version` field is a display string by contract, not a parse token.

**Fix.** Return the trimmed first line of combined output, falling back to the captured group when the first line is empty. Keep `VERSION_PATTERN` for the installed/parseable gate, but use the first line as the display value:
```ts
const version = output.split('\n')[0]?.trim() || match.groups.version;
```

**Regression test:** `detector returns full first version line including descriptive suffix (e.g. "2.1.129 (Claude Code)")` → assert exact line, proving display format is preserved.

---

### Finding 4 — Two public AiRunner methods dropped: runSlashCommand + buildPromptCommand

**Dimension:** Usability / API completeness
**Location:** `packages/ai-runner/src/ai-runner.ts` (absent)
**Origin:** `spur-old/.../ai-runner.ts:128-141`

**Dropped methods.**
1. `runSlashCommand(agent, input, promptOpts, opts)` — translates a Claude-style slash command via `translateSlashCommand` then dispatches through `runPromptCmd`. One-call ergonomics for the common CLI path.
2. `buildPromptCommand(agent, promptOpts): ShimCmd` — builds the prompt command WITHOUT executing — for preview/logging/dry-run.

`translateSlashCommand` still exists as a free function in `slash-command.ts`, but the runner no longer composes it; callers must translate manually before calling `runPromptCommand`.

**Why it matters.** Any spur caller that used `runner.runSlashCommand(...)` or `runner.buildPromptCommand(...)` is broken by the migration. These are public API.

**Action — DECISION REQUIRED before fixing.** Grep the spur (consuming) codebase for `runSlashCommand` / `buildPromptCommand` usage.
- If used → re-add both methods (signatures must adopt migrated names: `PromptOptions`, `AgentRunOptions`, `ShimCommand`, and `getAgentShim`). Note `buildPromptCommand` should reuse the identity-preamble enrichment path or document that it does NOT enrich (original did not).
- If unused → record an explicit decision here that they are intentionally dropped, and move on.

**Regression test (if re-added):**
- `runSlashCommand translates '/plugin:cmd args' for codex to '$plugin-cmd args' and dispatches` → assert executor received translated input.
- `buildPromptCommand returns the ShimCommand without invoking the executor` → assert executor NOT called.

---

### Finding 5 — Gemini auth downgraded from content-check to non-empty-file check

**Dimension:** Correctness
**Location:** `packages/ai-runner/src/doctor-runner.ts:95`
**Origin:** `spur-old/.../doctor-runner.ts:245-255` (`checkGeminiAuth`)

**Original:** read `~/.gemini/settings.json` and required its content to match `/auth|token|key/i` — verifies the settings actually contain credentials.
**Migrated:** `hasNonEmptyFile(~/.gemini/settings.json)` — any non-empty settings.json (even prefs-only, no auth) reports authenticated.

**Why it matters.** False positive: a gemini settings file holding only UI/editor prefs and no credentials → reported authenticated.

**Fix.** Read the file via injected `fs` and apply the `/auth|token|key/i` content test (origin behavior), wrapped in try/catch → false on read error. Use the migrated `FileSystem` async read, not `node:fs` `readFileSync`.

**Regression test:**
- `gemini reports UNAUTHENTICATED when settings.json exists but contains no auth/token/key field` → false.
- `gemini reports AUTHENTICATED when settings.json contains a "token" key` → true.

---

### Finding 6 — Version regex loosened from 3-part to 2-part semver

**Dimension:** Correctness
**Location:** `packages/ai-runner/src/agent-detector.ts:27` — `/(?<version>\d+\.\d+(?:\.\d+)?)/`
**Origin:** `spur-old/.../agent-detector.ts:63` — `/(?<version>\d+\.\d+\.\d+)/`

**Change.** Patch version is now optional. Outputs like `1.2` now parse as installed; originally required full `x.y.z`.

**Why flagged.** Likely intentional (more lenient detection), but it changes the installed/not-installed boundary for any CLI that prints a 2-part version. Could mask "version unparseable" cases the original rejected.

**Action — DECISION REQUIRED.** Confirm the loosening is intended. If yes, document it here and add a test pinning the 2-part behavior. If no, revert to 3-part.

**Regression test (whichever is chosen):** `detector parses a 2-part version "1.2" as installed` (or `... rejects "1.2" as unparseable`) — pin the decided semantics.

---

## P3 — Info

### Finding 7 — All structured logging removed (no observability on agent invocations)

**Dimension:** Maintainability / Observability
**Location:** `packages/ai-runner/src/ai-runner.ts`, `doctor-runner.ts` (absent)
**Origin:** `ai-runner.ts:38,43,181-203` (`getLogger(['kernel','ai-runner'])`, info on every invoke, error on non-zero exit); `doctor-runner.ts:34,39,159-163,205` (`getLogger(['cli','doctor'])`, info per agent check).

**Change.** Zero logging in the migrated package. Originally every CLI invocation logged `{label, cmd, args}` at info and non-zero exits at error; doctor logged per-agent check progress.

**Why flagged.** Given the repo's active "add observability" direction (recent commits + task 0015 EventBus work), this is likely a deliberate deferral pending the ts-infra logger wiring — but it IS a real capability gap: no trace of which agent commands ran or why a probe failed.

**Action — DECISION REQUIRED.** Decide whether ai-runner adopts `@gobing-ai/ts-infra` `getLogger` now (aligning with 0015) or defers. If adopting: log invoke at debug/info and non-zero exits at error/warn, matching original labels (`ai-runner.<agent>.<op>`). Record decision here either way.

---

### Finding 8 — Detector error messages flattened

**Dimension:** Usability (diagnostics)
**Location:** `packages/ai-runner/src/agent-detector.ts:61-66`
**Origin:** `spur-old/.../agent-detector.ts:174-196`

**Original** distinguished:
- signal termination: `Terminated by signal: ${signal}`
- null exit code: `Process did not produce an exit code`
- non-zero exit: `Non-zero exit code: ${code}. stderr: ${stderr.slice(0,200)}`

**Migrated** merges signal/null into one branch (`result.signal ?? 'Process timed out'`) and shortens the non-zero message. "Process timed out" is also a misattribution — a null exit code is not necessarily a timeout.

**Fix.** Restore the three distinct messages. Fix the misleading "Process timed out" default for the null-exit case (use the original "Process did not produce an exit code").

**Regression test:** `detector reports distinct error for signal termination vs null exit code` → assert the two error strings differ and the null case does not say "timed out".

---

### Finding 9 — detectChannels() seam removed (Phase-2 channel enrichment hook lost)

**Dimension:** Maintainability / roadmap
**Location:** `packages/ai-runner/src/agent-detector.ts:75` (hardcoded `channels: []`)
**Origin:** `spur-old/.../agent-detector.ts:225-236` (`detectChannels(name, output)` stub, documented: "Phase 2 adds `pi --list-models` parsing and other agent channels")

**Change.** The dedicated extension point for per-agent channel/model enrichment is gone; `channels: []` is inlined. Not a today-regression (both return `[]`), but the documented future-feature hook and its intent vanished.

**Action.** Decide: reinstate a `detectChannels(agent, output): string[]` private method returning `[]` (preserving the seam + roadmap comment), OR record that channel enrichment is descoped. The `channels` field remains in the public type either way.

---

### Finding 10 — doctor.runAll lost defensive "Unknown agent" synthesis over a fixed display order

**Dimension:** Correctness (robustness)
**Location:** `packages/ai-runner/src/doctor-runner.ts:61-64`
**Origin:** `spur-old/.../doctor-runner.ts:116-140`

**Original** iterated a fixed `DISPLAY_ORDER` and, for any name the detector did NOT return, synthesized an explicit `{ installed:false, error:"Unknown agent: <name>", tier }` row — guaranteeing exactly one row per known agent regardless of detector behavior.
**Migrated** maps over whatever `detectAll()` returns. Equivalent TODAY (both derive from the same `DISPLAY_ORDER`), but loses the decoupling: if the detector ever filters/dedupes, doctor silently returns fewer rows.

**Action.** Low priority. Either reinstate the fixed-order synthesis, or record that doctor intentionally trusts the detector's output set. No fix needed if decision is "trust detector."

---

## P4 — Suggestions

### Finding 11 — index.ts re-export surface narrowed (consequence of dropped methods)

**Dimension:** API
**Location:** `packages/ai-runner/src/index.ts`
**Origin:** `spur-old/.../index.ts`

The migrated index uses `export *` (broader by default) so most symbols flow through. No symbol is missing beyond what Findings 4/9 already cover (the dropped methods aren't separate exports). No action beyond resolving 4/9 — listed only for completeness so the re-export surface is re-verified after fixes.

---

## Fix sequencing (recommended)

1. **Findings 1 + 2 + 5** (auth false positives) — one coordinated rewrite of `checkAuth`, reintroducing `probeAuthOutput` + per-agent patterns, codex CLI-first order, gemini content-check. Keep ADR-011-clean injected `fs`/`env`. Add all auth regression tests together.
2. **Finding 3** (version display) — small, high-value.
3. **Finding 8** (error messages) — small.
4. **Findings 4 + 6 + 7 + 9 + 10** — each needs a DECISION (grep spur for 4; confirm intent for 6/7/9/10). Resolve decisions, then fix or document.
5. **Finding 11** — re-verify exports after the above.

**Gate after each step:** `bun run spur-check` (lint + typecheck + tests + both spur presets) and `bun run build`. No `--no-verify`, no skipped tests.


### Testing

- Date: 2026-06-05T01:20:00-07:00

- Command: `bun test packages/ai-runner/tests`
- Scope: package-local regression suite for ai-runner auth, detector, public runner methods, shims, team-mode files, and message service.
- Result: package tests passed `66/66`; command exited non-zero because direct package test coverage reporting included unrelated packages below threshold. Canonical workspace gate below is authoritative.
- Evidence: all ai-runner tests passed after updating stale version-display assertions.
- Next action: none.

- Command: `bun run lint`
- Scope: Biome formatting/lint plus per-package TypeScript typecheck.
- Result: PASS.
- Evidence: Biome checked 313 files; all package typechecks exited 0.
- Next action: none.

- Command: `bun run spur-check`
- Scope: repository canonical gate: lint, typecheck, pre-check spur rules, full test suite with coverage, post-check spur rules.
- Result: PASS.
- Evidence: 34 pre-check rules passed; `1109` tests passed with `0` failures; all post-check rules including coverage gate passed.
- Next action: none.

- Command: `bun run build`
- Scope: all workspace packages.
- Result: PASS.
- Evidence: all eight packages built successfully.
- Next action: none.



### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References


### History

- Migrated from legacy format (2026-07-31)
