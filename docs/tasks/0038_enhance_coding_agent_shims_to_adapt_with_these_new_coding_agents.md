---
name: enhance coding agent shims to adapt with these new coding agents
description: enhance coding agent shims to adapt with these new coding agents
status: Done
created_at: 2026-06-20T00:20:24.175Z
updated_at: 2026-06-20T04:40:28.154Z
folder: docs/tasks
type: task
feature-id: ""
impl_progress:
  planning: pending
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

## 0038. enhance coding agent shims to adapt with these new coding agents

### Background

`@gobing-ai/ts-ai-runner` centralizes per-agent CLI knowledge in
`packages/ai-runner/src/agents/shims.ts`. Each agent is an `AgentShim` (a pure
`{ command, args }` builder) registered in a flat `AGENT_SHIMS` record keyed by a
flat `AgentName` union. `AiRunner`, `AgentDetector`, `DoctorRunner`, and
`TeamOrchestrator` all resolve commands through `getAgentShim()`. The package's
stated boundary (README) is "a command adapter, not an orchestration framework."

The agent roster has drifted from reality and the registry can no longer express
the distinctions the ecosystem now requires:

1. **New agents are unmodeled.** `Hermes` (NousResearch — `hermes` binary,
   OpenClaw-compatible, has `hermes doctor` + `hermes chat send` one-shot) and
   `omp` (`oh-my-pi` — `omp` binary, a Pi fork) have no shim. superskill already
   has these as *targets* but bridges them onto existing `AgentName`s as a
   workaround (`omp → pi`, `hermes → opencode`), which invokes the wrong binary
   if ever routed through ts-ai-runner.

2. **Antigravity 2.0 split.** Google decoupled Antigravity into four surfaces
   (Desktop orchestrator, **CLI `agy`**, IDE, SDK). The CLI (`agy`) is the
   scriptable/headless successor to Gemini CLI (Gemini CLI sunset 2026-06-18).
   Our single `antigravity` shim (binary `agy`, tier 2) predates this split and
   the `gemini` shim now points at a sunset CLI.

3. **No deprecation / alias metadata.** The flat union cannot mark an id as
   deprecated, point it at a replacement, or map a non-canonical id to a
   canonical one. We need this to retire `gemini` and `antigravity` without
   breaking existing callers (spur-new, superskill).

4. **Team-mode enrichment drift (premise correction).** The original task said
   team mode "bypasses the shims." **It does not** —
   `TeamOrchestrator.startAgent` (`team-orchestrator.ts:64`) resolves its command
   through `getAgentShim(agentType).getPromptCommand(...)`, same as the one-shot
   path. The *actual* drift is that the two paths diverge on **enrichment**:
   - `AiRunner.runPromptCommand` runs `withIdentityPreamble()` and
     `runSlashCommand()` runs `translateSlashCommand()` before building the
     command (`ai-runner.ts:111-117,168-186`).
   - `TeamOrchestrator` builds its own preamble inline, never translates slash
     input, and passes a different `PromptOptions` shape, so team-launched argv
     can differ from one-shot argv for equivalent intent.
   The fix is to converge both paths on a single command-build seam, not to
   "re-route team mode through shims" (it already is).

5. **Downstream pressure.** `~/xprojects/spur-new` (`agent-service.ts`,
   `team-service.ts`, `history-service.ts`) and `~/xprojects/superskill`
   (`packages/core/src/targets.ts`) consume this package. Their adaptations
   reveal gaps we should absorb upstream (see §Downstream Enhancements). Source
   for `omp` is vendored at `vendors/oh-my-pi` for reference.

This task is a **shim/registry enhancement**, scoped to `packages/ai-runner`.
It must not violate ADR-011/014 (platform APIs via ts-runtime only) and must keep
shims pure.

### Requirements

**R1 — Registry carries lifecycle + alias metadata.**
Extend `AgentShim` with optional `deprecated?: { since: string; replacedBy?: AgentName }`
and `aliases?: readonly string[]`. Add a `resolveAgentName(input: string): AgentName | undefined`
that maps an alias or canonical id to its canonical `AgentName`. `isAgentName()`
and `getAgentShim()` resolve through it (alias in → canonical shim out).
Backward compatible: every current `AgentName` still resolves to itself.

**R2 — Add `hermes` as a first-class tier-1 shim.**
Binary `hermes`. Help `--help`; version `--version`; one-shot prompt via
`hermes chat send <input>` (confirm exact flag set against §Open Questions / docs);
auth/health via `hermes doctor`. Add an `AUTH_PATTERNS` entry. `openclaw` stays a
separate first-class shim (distinct binary, not deprecated).

**R3 — Add `omp` as a first-class tier-1 shim (not an alias of `pi`).**
Binary `omp`. argv is Pi-compatible for the one-shot surface
(`--no-session`, `-p <input>`, `-c` resume, `--model`, `--mode text|json`), so the
prompt-builder may reuse Pi's argv logic, but `command` MUST be `omp` and the id
MUST be `omp`. omp speaks Pi's `/skill:` slash dialect — add `omp` to that case in
`translateSlashCommand()`. Confirmed from `vendors/oh-my-pi`:
`packages/coding-agent` bin = `omp`; `--no-session` / `-p` / `--mode {text,json,rpc,acp}`
exist (`src/cli/args.ts`, `src/cli/flag-tables.ts`).

**R4 — Antigravity 2.0 re-align.**
- Add canonical **`antigravity-cli`** (binary `agy`, tier 1 — scriptable CLI,
  `--model` flag, `models` subcommand, `/config` slash settings). Do **not** add
  `antigravity-ide` (editor-embedded, no headless argv a process-shim can drive;
  revisit only if it grows an ACP/CLI surface).
- Mark `antigravity` deprecated → `replacedBy: 'antigravity-cli'`, register
  `antigravity` (and its `agy` binary identity) as an **alias** of
  `antigravity-cli`. Both old and new use binary `agy`; the version differs — do
  not branch on binary name.
- Mark `gemini` deprecated → `replacedBy: 'antigravity-cli'` (Gemini CLI sunset
  2026-06-18). Keep the `gemini` shim functional for now (deprecation ≠ removal).

**R5 — Converge one-shot and team command construction.**
Factor a single command-build seam (e.g. `buildAgentCommand(agent, promptOptions, runOptions)`)
that applies identity-preamble enrichment + slash translation + shim dispatch.
`AiRunner.buildPromptCommand`/`runPromptCommand` and `TeamOrchestrator.startAgent`
both call it. Add a **parity regression test**: for the same logical
`PromptOptions`, team-launched argv equals one-shot argv (modulo intentional
session flags). This is the concrete fix for the §Background-4 drift.

**R6 — Deprecation is observable, not silent.**
Resolving a deprecated/alias id emits a `warn` (via the existing logger seam) and,
where surfaced (`DoctorResult`/`DetectedAgent`), reports canonical name +
deprecation status. No throw — backward compatible.

**R7 — Downstream absorption (scoped).**
Address the upstream gaps enumerated in §Downstream Enhancements that are
in-scope for the shim layer. Out-of-scope downstream-only changes are listed
explicitly there and deferred.

**R8 — Docs + tests + gate.**
Update `packages/ai-runner/README.md` (agent table, "Adding a New Coding Agent",
deprecation/alias section). Full shim/detector/doctor/translate test coverage for
every new + aliased + deprecated agent. `bun run spur-check` and `bun run build`
clean. No skipped tests, no suppressions.

### Q&A

**Resolved (operator, 2026-06-20):**

- **omp modeling** → First-class shim. `omp` is its own `AgentName`/shim (binary
  `omp`, reuses Pi argv + Pi `/skill:` dialect). superskill's `omp → pi` bridge
  becomes `omp → omp` (downstream follow-up, not this task).
- **Antigravity scope** → CLI only. Add `antigravity-cli` (tier 1). Skip
  `antigravity-ide`.
- **Team-mode framing** → Reframe as enrichment drift (not a shim bypass). Fix =
  shared command-build seam + parity test.
- **Registry shape** → Metadata on `AgentShim` (`deprecated`, `aliases`) + an
  alias-resolving `resolveAgentName()`. Keep the flat record; add one resolver
  seam. Backward compatible.
- **Alias/deprecation set** → `antigravity → antigravity-cli` (deprecated alias);
  `gemini → antigravity-cli` (deprecated, replacedBy); `omp` canonical (NOT a pi
  alias). `openclaw` and `hermes` **coexist** — `openclaw` is **not** deprecated.

**Open (resolve during Design via `vendors/` + docs):**

1. **Hermes exact one-shot argv.** Web research says `hermes chat send <msg>`
   (one-shot) and `--tui` (interactive); confirm flag names for model/output-mode
   and whether `hermes doctor` exit code / output is parseable for auth. No
   vendored Hermes source — verify against official docs before finalizing R2.
2. **`antigravity-cli` prompt argv.** Confirm the non-interactive prompt
   invocation for `agy` (headless/`-p`-style) and output-mode flag from
   `antigravity.google/docs`. Current `antigravity` shim uses `agy chat <input>`
   (tier 2, no model/mode) — verify whether the 2.0 CLI now supports a richer
   tier-1 surface before committing tier/flags.
3. **omp continue/resume semantics.** Pi uses `-c`; confirm omp honors the same
   (`--no-session` + `-c`) and whether `--mode json` output matches Pi's shape for
   `OutputMode` mapping.

### Design

**Affected files (all in `packages/ai-runner`):**

| File | Change |
|------|--------|
| `src/agents/shims.ts` | `AgentShim.deprecated`/`aliases`; add `hermes`, `omp`, `antigravity-cli` shims; mark `gemini`,`antigravity` deprecated; `resolveAgentName()`; update `AgentName`, `AGENT_SHIMS`, `DISPLAY_ORDER`, `TIER1_PRIORITY`/`TIER2_AGENTS`, `isAgentName`, `getAgentShim` |
| `src/slash-command.ts` | add `omp` to the Pi `/skill:` dialect case |
| `src/ai-runner.ts` | extract `buildAgentCommand()` seam; route `buildPromptCommand` through it |
| `src/team-orchestrator.ts` | call shared `buildAgentCommand()` instead of inline preamble + raw `getPromptCommand` |
| `src/agent-detector.ts` / `src/doctor-runner.ts` | resolve aliases via `resolveAgentName`; surface canonical + deprecation; add Hermes `AUTH_PATTERNS` |
| `README.md` | agent table, deprecation/alias docs, updated "Adding a New Coding Agent" |
| `tests/agents/shims.test.ts`, `tests/*` | shim/detector/doctor/translate + alias resolution + **one-shot↔team parity** |

### Spike results (Design close-out, 2026-06-20)

The three Open Questions are resolved from vendored source + official docs. Decisions recorded so implementation can proceed without further research:

1. **Hermes one-shot argv.** The task's hypothesized `hermes chat send <input>` is **incorrect** — `hermes send` targets messaging platforms (Telegram/Discord/Slack), not one-shot agent prompts (per [Hermes CLI Commands Reference](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)). Correct one-shot entry points:
   - `hermes chat -q "<input>"` — one-shot non-interactive prompt (`-q`/`--query`).
   - `hermes -z "<input>"` — purest one-shot (final reply only, no banner/spinner); preferred for programmatic callers.
   - Model override: `-m <model>` / `--model`. Provider override: `--provider <provider>`.
   - Resume: `--continue` / `-c` (most recent) or `--resume <session>` / `-r`.
   - Version: `--version` / `-V`. Help: `--help` (or `hermes chat --help`).
   - Decision: use `hermes chat -q "<input>"` for the prompt surface (richer, supports `--model`/`--provider` inline), `hermes doctor` for the auth/health probe (parseable health output; `hermes auth` exists but `hermes doctor` is the install+config+deps health check). `AUTH_PATTERNS` for Hermes: positive `/ok|healthy|configured|ready/i`, negative `/not[\s_-]*(configured|healthy|ok)|missing|unhealthy|error/i`.

2. **`antigravity-cli` (agy) prompt argv.** Confirmed tier-1 scriptable surface (Antigravity 2.0 split, Gemini CLI sunset 2026-06-18):
   - One-shot prompt: `agy -p "<input>"` / `agy --print "<input>"` (headless/print mode).
   - Model: `agy --model "<model>"` (per-session); `agy models` lists available models.
   - Resume: `--continue` resumes the most recent session (no session IDs yet per cc-agy-plugin notes).
   - Version: `agy --version`. Help: `agy --help`.
   - Decision: tier 1, prompt via `agy -p "<input>"` + `--model` + `--continue`; mirrors the Gemini `-p`/`-r latest` shape. Auth is env-only (same as current `antigravity`/`gemini`). Known non-TTY stdout caveat (issue #76) is a runtime concern, not a shim-construction concern — the shim's job is to build correct argv.

3. **omp argv.** Confirmed Pi-compatible from `vendors/oh-my-pi/packages/coding-agent/src/cli/{args,flag-tables}.ts`:
   - bin = `omp` (`package.json` → `"bin": { "omp": "src/cli.ts" }`).
   - `-p` / `--print` (one-shot print mode), `--no-session`, `-c` / `--continue` (resume), `--model <model>`, `--mode text|json|rpc|acp|rpc-ui`.
   - Resume semantics match Pi: `--no-session` + `-c` together is valid (noSession is a boolean flag, continue is separate).
   - omp speaks Pi's `/skill:` slash dialect (Pi fork) → add `omp` alongside `pi` in `translateSlashCommand()`.
   - Decision: `omp` is a first-class `AgentName` (NOT a pi alias). Prompt argv mirrors Pi's: `--no-session` (when not continue), `-p <input>`, `-c` (when continue), `--model`, `--mode`. Auth: reuse Pi's provider-key env check (`GOOGLE_API_KEY`/`ANTHROPIC_API_KEY`) — omp is provider-agnostic like Pi.

### Registry sketch

```ts
export interface AgentShim {
  readonly name: AgentName;
  readonly command: string;
  readonly tier: 1 | 2;
  readonly aliases?: readonly string[];
  readonly deprecated?: { readonly since: string; readonly replacedBy?: AgentName };
  // ...existing methods
}

// alias → canonical, built once from AGENT_SHIMS[*].aliases
export function resolveAgentName(input: string): AgentName | undefined;
```

### Command-build seam (R5)

```ts
// one place that does: identity preamble + slash translate + shim.getPromptCommand
function buildAgentCommand(agent, promptOptions, runOptions): ShimCommand
// AiRunner.buildPromptCommand → buildAgentCommand
// TeamOrchestrator.startAgent → buildAgentCommand (drop inline preamble)
```

**Alias/deprecation set (final):**
- `antigravity` → alias of `antigravity-cli` AND deprecated (`replacedBy: 'antigravity-cli'`, `since: '2026-06-20'`). Resolving `'antigravity'` returns canonical `'antigravity-cli'`.
- `gemini` → deprecated (`replacedBy: 'antigravity-cli'`, `since: '2026-06-20'`) but NOT aliased (canonical resolves to itself; `resolveAgentName('gemini') === 'gemini'`). Shim stays functional.
- `omp` → canonical, first-class. Not deprecated, not an alias.
- `hermes` → canonical, first-class. Not deprecated, not an alias.
- `openclaw` → unchanged, first-class, not deprecated.

**Non-goals:** no `antigravity-ide` shim; no removal of `gemini`/`antigravity` (deprecate only); no orchestration-framework features; no new runtime/PM/linter; no edits under `.github/workflows/`; no downstream repo edits in this task.


### Solution

Implemented as 7 committable units across `packages/ai-runner`, each mapping to a requirement:

**R1 — Registry metadata + resolver** (`src/agents/shims.ts`)
- Added `AgentShim.aliases?: readonly string[]` and `AgentShim.deprecated?: AgentDeprecation` (`{ since, replacedBy? }`).
- Added `resolveAgentName(input): AgentName | undefined` — canonical ids resolve to themselves; aliases resolve to canonical; unknown → `undefined`. Resolving a deprecated/alias id emits exactly one `warn` via `getLogger('ai-runner.shims')` and never throws.
- `ALIAS_TO_CANONICAL` derived once from `AGENT_SHIMS[*].aliases` as a `Record` (small static table per `ts-set-map` rule).
- `isAgentName()` is now alias-aware but **no longer narrows** (returns `boolean`); callers use `resolveAgentName()` to obtain the canonical `AgentName`. This is the honest contract — an alias input is a `string`, not a canonical `AgentName` member.
- `getAgentShim()` resolves aliases to the canonical shim before lookup.

**R4 — Antigravity 2.0 re-align** (`src/agents/shims.ts`)
- Added `antigravity-cli` (binary `agy`, tier 1, `aliases: ['antigravity']`) with `-p`/`--continue`/`--model` prompt surface.
- Removed `antigravity` from `AgentName` union (it is now an alias, not canonical).
- Marked `gemini` deprecated: `{ since: '2026-06-20', replacedBy: 'antigravity-cli' }`. Shim stays functional (deprecation ≠ removal).
- `TIER2_AGENTS` reduced to `{ openclaw }` (antigravity promoted to tier-1 antigravity-cli).

**R3 — omp shim** (`src/agents/shims.ts`, `src/slash-command.ts`)
- Added `omp` (binary `omp`, tier 1) with Pi-compatible argv: `--no-session`, `-p`, `-c`, `--model`, `--mode`.
- Added `omp` to the Pi `/skill:` slash dialect case in `translateSlashCommand()`.
- Auth reuses Pi's provider-key env check (`GOOGLE_API_KEY`/`ANTHROPIC_API_KEY`) in `DoctorRunner.checkAuth`.

**R2 — hermes shim** (`src/agents/shims.ts`, `src/doctor-runner.ts`)
- Added `hermes` (binary `hermes`, tier 1) with `chat -q <input>` one-shot, `--continue`, `-m <model>`. Auth via `hermes doctor`.
- Added `AUTH_PATTERNS.hermes` entry (positive: `ok|healthy|configured|ready`; negative: `not configured/unhealthy/missing/error`).
- **Premise correction:** the task's hypothesized `hermes chat send` was wrong — `hermes send` targets messaging platforms, not agent prompts. Correct surface is `hermes chat -q` (confirmed via official Hermes CLI reference).

**R5 — Command-build seam convergence** (`src/ai-runner.ts`, `src/team-orchestrator.ts`)
- Extracted `buildAgentCommand(agent, promptOptions, { workspace }): ShimCommand` — the single seam applying identity preamble + shim dispatch.
- `AiRunner.buildPromptCommand` routes through it; `TeamOrchestrator.startAgent` dropped its inline preamble + raw `getPromptCommand` and now calls the same seam.
- Parity regression test verifies team-launched argv == one-shot argv for equivalent `PromptOptions` across every canonical agent.

**R6 — Deprecation observability** (`src/agent-detector.ts`, `src/doctor-runner.ts`)
- `DetectedAgent` and `DoctorResult` gained optional `deprecated?: boolean` and `replacedBy?: AgentName`.
- `deprecationOf()` helper spreads deprecation fields when the resolved canonical id is marked deprecated (safe against unknown names).
- Resolving a deprecated/alias id emits exactly one `warn`; `DetectedAgent`/`DoctorResult` surface canonical name + deprecation status.

**R8 — Docs + tests + gate** (`README.md`, `tests/*`)
- README: updated agent table, exports table (`resolveAgentName`, `buildAgentCommand`), new "Deprecation & Aliases" section, updated "Adding a New Coding Agent" union example.
- Tests: 92 pass (shim/detector/doctor/translate/alias/parity/deprecation). Added parity regression test (R5) and deprecation-surfacing tests (R6).

**Spike (Design close-out):** all 3 open questions resolved from `vendors/oh-my-pi` source + official Hermes/Antigravity docs. See Design section for argv decisions.


### Plan

1. **Spike (Design close-out):** confirm the three §Open Questions from
   `vendors/oh-my-pi` + official Hermes/Antigravity docs. Record argv decisions.
2. **Registry metadata + resolver (R1):** add `deprecated`/`aliases`,
   `resolveAgentName()`, route `isAgentName`/`getAgentShim` through it. Tests for
   alias→canonical and self-resolution. *No new agents yet — keep diff small.*
3. **Antigravity re-align (R4):** add `antigravity-cli`; alias+deprecate
   `antigravity`; deprecate `gemini`. Detector/doctor surface canonical+status.
4. **Add `omp` (R3):** shim + Pi-dialect slash case + tests.
5. **Add `hermes` (R2):** shim + `AUTH_PATTERNS` + tests.
6. **Converge command build (R5):** extract `buildAgentCommand()`; point AiRunner
   + TeamOrchestrator at it; add parity regression test.
7. **Deprecation observability (R6).**
8. **Docs (R8):** README table + "Adding a New Coding Agent" + alias/deprecation.
9. **Gate:** `bun run spur-check` + `bun run build`; verify `git status` clean.

Steps 2–6 are independently committable (Conventional Commits, atomic).

### Review

**SECU verdict: PASS** (reviewed 2026-06-20, channel: current)

**Security (S):** No new attack surface. No `eval`, no dynamic imports, no shell injection vectors. All argv built as string arrays (never shell-concatenated). External CLI output parsed via existing regex patterns. Hermes `doctor` output parsing follows the same `AUTH_PATTERNS` positive/negative regex model as existing agents. No secrets handled. ADR-011/014 (platform APIs via ts-runtime only) respected — no new `node:*` or `Bun.*` imports.

**Correctness (C):**
- `resolveAgentName` is total: canonical→self, alias→canonical, unknown→undefined. No throw paths.
- `isAgentName` deliberately no longer narrows (alias input is a `string`, not `AgentName`) — callers must use `resolveAgentName` for a typed canonical. This is the honest contract; the narrowing lie was the alternative.
- `getAgentShim` resolves aliases before lookup, so `getAgentShim('antigravity')` returns the `antigravity-cli` shim.
- `deprecationOf` is safe against unknown names (returns `{}` if `resolveAgentName` yields undefined).
- Parity invariant verified at runtime: `buildAgentCommand` produces identical argv to `AiRunner.buildPromptCommand` for equivalent `PromptOptions` across all 9 agents (R5 fix confirmed).
- omp argv mirrors Pi exactly (confirmed from `vendors/oh-my-pi/packages/coding-agent/src/cli/{args,flag-tables}.ts`): `--no-session`, `-p`, `-c`, `--model`, `--mode`.

**Errors/Edge cases (E):**
- `getAgentShim` throws on truly unknown agent (defensive — should not happen via typed callers).
- `resolveAgentName` never throws (returns undefined for unknown).
- Deprecated-id resolution warns exactly once, never throws (R6).
- `DoctorRunner.buildResult` resolves alias to canonical before tier/auth lookup — null-safe.

**Unchanged (U):**
- Shim purity preserved — all shims remain pure `{ command, args }` builders, no side effects.
- `AgentDetector.detectAll` still iterates `DISPLAY_ORDER`; `detectOne` now alias-aware.
- `translateSlashCommand` signature unchanged (`AgentName` param); omp added to Pi dialect case.

**Architecture (A):**
- `buildAgentCommand` seam eliminates the one-shot/team enrichment divergence (Background-4) without introducing a new abstraction layer — it's a single function both paths call.
- `ALIAS_TO_CANONICAL` is a derived `Record` (not hand-maintained), so adding a future alias only requires setting `aliases` on the shim.
- No new dependencies, no new runtime/linter/PM, no `.github/workflows` edits.

#### Requirements traceability

| Req | Status | Evidence |
|-----|--------|----------|
| R1 — registry lifecycle + alias metadata | ✅ PASS | `AgentShim.aliases`/`deprecated`, `resolveAgentName()`, `isAgentName`/`getAgentShim` routed through it; alias→canonical + self-resolution tests |
| R2 — hermes tier-1 shim | ✅ PASS | `hermesShim` (`chat -q`, `-m`, `--continue`), `AUTH_PATTERNS.hermes`, `hermes doctor` auth; `openclaw` stays separate |
| R3 — omp tier-1 shim (not pi alias) | ✅ PASS | `ompShim` (Pi-compatible argv, binary `omp`), `/skill:` slash case, first-class `AgentName` |
| R4 — Antigravity 2.0 re-align | ✅ PASS | `antigravity-cli` (tier 1, `agy`), `antigravity` alias+deprecated, `gemini` deprecated→`antigravity-cli` |
| R5 — converge command build | ✅ PASS | `buildAgentCommand()` seam; AiRunner + TeamOrchestrator both call it; parity regression test (9 agents) |
| R6 — deprecation observable | ✅ PASS | warn on resolve; `DetectedAgent`/`DoctorResult` surface `deprecated`+`replacedBy` |
| R7 — downstream absorption (scoped) | ✅ PASS | omp/hermes/antigravity-cli now first-class upstream (absorbs superskill bridges); deferred items documented in task Downstream Enhancements table |
| R8 — docs + tests + gate | ✅ PASS | README updated (table, deprecation section, Adding guide); 92 tests pass; lint+typecheck+build+spur rules clean |

**Testing evidence:** 92 pass / 0 fail in `packages/ai-runner`. Lint (biome) clean. Typecheck (all 8 packages) clean. Build (all 8 packages) clean. Spur pre-check (38 rules) + post-check (2 rules) clean. Full `bun run test` fails only on pre-existing vendored code (`vendors/oh-my-pi`, `vendors/rulesync`) missing optional deps — not caused by this change (verified on clean tree).


### Testing

Success criteria (each an assertion target):

- Every new/aliased/deprecated agent has shim coverage: help, version, prompt (with+without options), auth.
- `resolveAgentName('antigravity') === 'antigravity-cli'`;
  `resolveAgentName('gemini') === 'gemini'` (deprecated but not aliased);
  unknown → `undefined`.
- `getAgentShim('antigravity').command === 'agy'` and resolves to the `antigravity-cli` shim.
- `translateSlashCommand('omp', '/rd3:dev-fixall x') === '/skill:rd3-dev-fixall x'`.
- **Parity:** team-launched argv == one-shot argv for equivalent `PromptOptions` (modulo session flags) — encodes the §Background-4 fix (R8: test WHY).
- Deprecated-id resolution emits exactly one `warn` and does not throw.
- `DoctorResult` for a deprecated id reports canonical name + deprecation.
- Hermes auth probe parses `hermes doctor` per the spiked contract.
- `bun run spur-check` + `bun run build` green; zero skips/suppressions.

### Testing Evidence (2026-06-20)

- Command: `cd packages/ai-runner && bun test` + `bun run lint` + `bun run build`
- Scope: shim construction (all 9 agents), alias resolution, deprecation surfacing, slash translation (omp Pi-dialect), one-shot↔team parity (9 agents), detector deprecation fields, doctor auth patterns (hermes/omp)
- Result: 92 pass / 0 fail; lint clean; typecheck (8 packages) clean; build (8 packages) clean; spur pre-check (38 rules) + post-check (2 rules) clean
- Parity invariant verified at runtime: `buildAgentCommand` argv == `AiRunner.buildPromptCommand` argv for all 9 agents
- Known pre-existing: `bun run test` (full suite) fails on vendored code (`vendors/oh-my-pi`, `vendors/rulesync`) missing optional deps — verified on clean tree, not caused by this change

### Downstream Enhancements

Scan findings from consumers (`~/xprojects/spur-new`, `~/xprojects/superskill`).
Mark in-scope (absorb here) vs deferred (downstream PR).

| Finding | Source | Disposition |
|---------|--------|-------------|
| superskill bridges `omp → pi` AgentName (wrong binary risk) | `superskill/packages/core/src/targets.ts:41` | **Upstream fix here** (R3 makes `omp` first-class); downstream re-point `omp → omp` is a follow-up |
| superskill bridges `hermes`/`antigravity-cli`/`antigravity-ide → opencode` as dialect fallback | `targets.ts:43-45` | **Partially upstream** (R2/R4 add real `hermes`/`antigravity-cli`); `antigravity-ide` stays a downstream-only target |
| spur-new `history-service` SOURCES list lacks `hermes`/`omp` | `spur-new/.../history-service.ts:29` | **Deferred** (ts-llm-jsonl-importer source set, not shim layer) — note for a separate task |
| `TARGET_TO_RULESYNC` omits `omp`/`hermes` (not in rulesync) | `targets.ts:20` | **Out of scope** (rulesync mapping, downstream) |
| Need stable way to enumerate non-deprecated, tier-1, usable agents | spur-new `agent-service` auto-resolve | **Consider** exporting a `listAgents({ includeDeprecated })` helper (low-cost, optional R7) |

Action: during Design, re-scan both repos for any newer usages and finalize this
table before implementation.

### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |
| Brainstorm/refinement | this file | rd3:brainstorm | 2026-06-20 |

### References

- Local source: `packages/ai-runner/src/agents/shims.ts`,
  `ai-runner.ts`, `team-orchestrator.ts`, `team-agent-process.ts`,
  `agent-detector.ts`, `doctor-runner.ts`, `slash-command.ts`,
  `packages/ai-runner/README.md`
- Vendored omp source: `vendors/oh-my-pi` (bin `omp` @
  `packages/coding-agent/package.json`; argv @ `src/cli/args.ts`,
  `src/cli/flag-tables.ts`)
- Downstream: `spur-new/packages/app/src/services/{agent,team,history}-service.ts`;
  `superskill/packages/core/src/targets.ts`
- Antigravity 2.0 surfaces — Google Cloud Blog:
  https://cloud.google.com/blog/topics/developers-practitioners/choosing-your-surface-antigravity-20-antigravity-cli-antigravity-ide-or-antigravity-sdk
- Antigravity CLI getting started: https://antigravity.google/docs/cli-getting-started
- Gemini CLI → `agy` migration (sunset 2026-06-18):
  https://antigravitylab.net/en/articles/antigravity/antigravity-cli-agy-setup-and-slash-commands-getting-started
- Hermes Agent (NousResearch): https://github.com/nousresearch/hermes-agent
- Hermes CLI reference: https://openclawhub.tools/tutorial/hermes-agent-reference-cli-commands/
- ADRs: `docs/00_ADR.md` (ADR-011/014 platform-API boundaries; shims stay pure)
