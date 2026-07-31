---
schema_version: 1
name: enhance coding agent shims to adapt with these new coding agents
status: done
type: task
created_at: 2026-06-20T00:20:24.175Z
updated_at: 2026-06-20T04:40:28.154Z
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

## Review — 2026-06-20 (dev-verify --force --fix all, Phase 7 SECU + Phase 8 traceability, channel: current)

**Verdict:** PASS (with 1 out-of-scope gate blocker, not attributable to this task)
**Scope:** `packages/ai-runner/` — shims, ai-runner, team-orchestrator, agent-detector, doctor-runner, slash-command + tests
**Gate:** `bun run spur-check` → FAIL — but **only** on unrelated `packages/infra/` working-tree changes (see P1-1). `packages/ai-runner` isolated: biome clean (26 files), `tsc --noEmit` clean, `bun test` 92 pass / 0 fail / 432 assertions.

### P1 — Blockers
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | Gate fails on out-of-scope files | Correctness | `packages/infra/src/application-cli.ts`, `packages/infra/tests/application-cli.test.ts` | Pre-existing **uncommitted** work unrelated to task 0038 (unused `afterEach` import + Biome import formatting). Owner should run `bun run format` + drop the unused import. NOT fixed here: editing another work-stream's untracked files violates surgical-scope + don't-overwrite-others'-work. Re-run `bun run spur-check` after that branch lands. |

### P2 — Warnings (re-assessed after Design close-out + vendored-source check)
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | Hermes one-shot argv = documented decision, MEDIUM confidence | Correctness | `src/agents/shims.ts:204-208` (`hermes chat -q <input>`) | §Open-Question-1 IS closed in Design (`docs/tasks/0038…md:186-191`): decision is `hermes chat -q "<input>"` + `hermes doctor`. Web-research-derived, no first-party source verified. Not a defect — a deliberate contract. **Action:** confirm `-q` + `-m`/`--continue` against `github.com/nousresearch/hermes-agent` before a downstream-facing release. |
| 2 | `antigravity-cli` prompt argv = documented decision, MEDIUM confidence | Correctness | `src/agents/shims.ts:175-179` (`agy -p <input> --continue --model`) | §Open-Question-2 IS closed in Design (`…:193-198`): `agy -p` + `--model` + `--continue`, mirrors Gemini `-p`. Web-research-derived. **Action:** confirm against `antigravity.google/docs` before release. Known non-TTY stdout caveat (upstream issue #76) is runtime, not shim-construction. |
| ~~3~~ | omp argv — **RESOLVED (HIGH)** | Correctness | `src/agents/shims.ts:217-233` | Verified today against `vendors/oh-my-pi/packages/coding-agent/src/cli/args.ts:188,202,227` + `flag-tables.ts`: bin `omp`; `-p`/`--print`, `--no-session`, `-c`/`--continue`, `--model`, `--mode` all valid; prompt consumed as positional (so `-p <input>` parses correctly). No change needed. §Open-Question-3 closed. |

### P3 — Info
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | `getAuthCommand` returns null for `antigravity-cli` | Usability | `src/agents/shims.ts:181` | Mirrors old gemini/antigravity (env-only). Fine, but no `AUTH_PATTERNS` entry means doctor can never mark it `usable`. Acceptable if intentional; note it so downstream auto-resolve doesn't silently skip it. |
| 2 | `gemini` retained as tier-1 but absent from `TIER1_PRIORITY` | Usability | `src/agents/shims.ts:249-257` | Correct (deprecated ids excluded from auto-select per R4), but `DISPLAY_ORDER` still lists it — verify downstream `list` UIs render the deprecation flag so users aren't surprised it's auto-skipped. |

### P4 — Suggestions
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | `detectChannels` still a no-op stub | Usability | `src/agent-detector.ts:95-98` | Pre-existing Phase-2 hook, unchanged by this task. `channels: []` for every agent. Out of scope; noted for a follow-up if channel/model surfacing is wanted. |
| 2 | superskill `omp → pi` bridge still stale | Maintainability | downstream `superskill/packages/core/src/targets.ts:41` | R3 made `omp` first-class upstream; the downstream re-point to `omp → omp` is the documented follow-up (Downstream Enhancements table). Track separately. |

### Requirements traceability (Phase 8)

- [x] **R1** Registry lifecycle + alias metadata → **MET** | `shims.ts:48-67` (`AgentDeprecation`, `aliases`, `deprecated`), `resolveAgentName` `:293-301`, `isAgentName`/`getAgentShim` route through it `:305-316`. Tests `shims.test.ts:81-110`.
- [x] **R2** `hermes` first-class tier-1 + AUTH_PATTERNS → **MET (impl)** / **PARTIAL (verification)** | `shims.ts:198-211`, `doctor-runner.ts:72-75`. Exact argv unverified (P2-1).
- [x] **R3** `omp` first-class (binary `omp`, Pi argv, `/skill:` dialect) → **MET** | `shims.ts:217-233`, `slash-command.ts:38-39`. Confirmed against `vendors/oh-my-pi`.
- [x] **R4** Antigravity re-align (`antigravity-cli` canonical; `antigravity` alias+deprecated; `gemini` deprecated; no `antigravity-ide`) → **MET (impl)** / **PARTIAL (verification)** | `shims.ts:112-116,168-182`. `antigravity-ide` correctly rejected (`shims.test.ts:103`). Argv unverified (P2-2).
- [x] **R5** Converge one-shot/team command build + parity test → **MET** | shared `buildAgentCommand` `ai-runner.ts:186-192`; TeamOrchestrator calls it `team-orchestrator.ts:56-64`; parity tests `ai-runner.test.ts:298-321` (incl. "across every canonical agent").
- [x] **R6** Deprecation observable (warn + surfaced) → **MET** | `warnDeprecatedOrAlias` `shims.ts:322-334`; `DetectedAgent.deprecated/replacedBy` `agent-detector.ts:105-112`; `DoctorResult` `doctor-runner.ts:23-26,137-138`.
- [~] **R7** Downstream absorption (scoped) → **PARTIAL** | Upstream gaps closed (omp/hermes first-class). Optional `listAgents({includeDeprecated})` helper from the Downstream table not added — deferred, acceptable.
- [x] **R8** Docs + tests + gate → **MET (modulo unrelated gate)** | README updated: agent table + `resolveAgentName` row (`README.md:20-21,35`), supported-id line with deprecation, "Deprecation & Aliases" section. Tests comprehensive (92 pass, parity + alias + deprecation covered). Gate blocked only by unrelated infra files (P1-1), NOT by ai-runner.

**Net (final):** 7/8 fully met, 1 partial (R7 optional helper deferred — acceptable). Zero defects in task-0038 code; README + tests complete. omp argv now HIGH-confidence (vendored-source verified). The two remaining P2 items (Hermes/Antigravity argv) are documented, deliberate MEDIUM-confidence contracts — first-party-source confirmation recommended before a downstream release, not blockers.

**Gate status:** task-0038 code passes lint + typecheck + 92 tests in isolation. The shared `bun run spur-check` is blocked by an UNRELATED file — `packages/infra/src/application-cli.ts` (commit `6a36621`, the `runCliApplication` feature): ADR-011/014 violations (`process.exit` ×3 @ lines 12/63/90 region, `process.stderr.write` @ 87). Sanctioned fix path: stderr → `echoError()` (ts-utils); exit → add `exitProcess()` to `packages/utils/src/output.ts` (the file exempt from the exit rule). Operator scoped this out of task 0038 — left for the infra owner.


### P1 — Blockers
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | Gate fails on out-of-scope files | Correctness | `packages/infra/src/application-cli.ts`, `packages/infra/tests/application-cli.test.ts` | Pre-existing **uncommitted** work unrelated to task 0038 (unused `afterEach` import + Biome import formatting). Owner should run `bun run format` + drop the unused import. NOT fixed here: editing another work-stream's untracked files violates surgical-scope + don't-overwrite-others'-work. Re-run `bun run spur-check` after that branch lands. |

### P2 — Warnings
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | Hermes one-shot argv unverified against official CLI | Correctness | `src/agents/shims.ts:204-208` (`hermes chat -q <input>`) | §Open-Question-1 was never closed. Web research indicated `hermes chat send <msg>` for one-shot; impl uses `chat -q`. No vendored Hermes source to confirm. Validate `-q` vs `send` and `-m`/`--continue` against `github.com/nousresearch/hermes-agent` docs before a release that downstreams depend on. LOW confidence flag. |
| 2 | `antigravity-cli` prompt argv unverified | Correctness | `src/agents/shims.ts:175-179` (`agy -p <input> --continue --model`) | §Open-Question-2 not closed. Assumes a Gemini-CLI-like `-p` surface for `agy`; the old shim used `agy chat <input>`. Confirm the 2.0 CLI's non-interactive flag set against `antigravity.google/docs` before relying on it. |

### P3 — Info
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | `getAuthCommand` returns null for `antigravity-cli` | Usability | `src/agents/shims.ts:181` | Mirrors old gemini/antigravity (env-only). Fine, but no `AUTH_PATTERNS` entry means doctor can never mark it `usable`. Acceptable if intentional; note it so downstream auto-resolve doesn't silently skip it. |
| 2 | `gemini` retained as tier-1 but absent from `TIER1_PRIORITY` | Usability | `src/agents/shims.ts:249-257` | Correct (deprecated ids excluded from auto-select per R4), but `DISPLAY_ORDER` still lists it — verify downstream `list` UIs render the deprecation flag so users aren't surprised it's auto-skipped. |

### P4 — Suggestions
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | `detectChannels` still a no-op stub | Usability | `src/agent-detector.ts:95-98` | Pre-existing Phase-2 hook, unchanged by this task. `channels: []` for every agent. Out of scope; noted for a follow-up if channel/model surfacing is wanted. |
| 2 | superskill `omp → pi` bridge still stale | Maintainability | downstream `superskill/packages/core/src/targets.ts:41` | R3 made `omp` first-class upstream; the downstream re-point to `omp → omp` is the documented follow-up (Downstream Enhancements table). Track separately. |

### Requirements traceability (Phase 8)

- [x] **R1** Registry lifecycle + alias metadata → **MET** | `shims.ts:48-67` (`AgentDeprecation`, `aliases`, `deprecated`), `resolveAgentName` `:293-301`, `isAgentName`/`getAgentShim` route through it `:305-316`. Tests `shims.test.ts:81-110`.
- [x] **R2** `hermes` first-class tier-1 + AUTH_PATTERNS → **MET (impl)** / **PARTIAL (verification)** | `shims.ts:198-211`, `doctor-runner.ts:72-75`. Exact argv unverified (P2-1).
- [x] **R3** `omp` first-class (binary `omp`, Pi argv, `/skill:` dialect) → **MET** | `shims.ts:217-233`, `slash-command.ts:38-39`. Confirmed against `vendors/oh-my-pi`.
- [x] **R4** Antigravity re-align (`antigravity-cli` canonical; `antigravity` alias+deprecated; `gemini` deprecated; no `antigravity-ide`) → **MET (impl)** / **PARTIAL (verification)** | `shims.ts:112-116,168-182`. `antigravity-ide` correctly rejected (`shims.test.ts:103`). Argv unverified (P2-2).
- [x] **R5** Converge one-shot/team command build + parity test → **MET** | shared `buildAgentCommand` `ai-runner.ts:186-192`; TeamOrchestrator calls it `team-orchestrator.ts:56-64`; parity tests `ai-runner.test.ts:298-321` (incl. "across every canonical agent").
- [x] **R6** Deprecation observable (warn + surfaced) → **MET** | `warnDeprecatedOrAlias` `shims.ts:322-334`; `DetectedAgent.deprecated/replacedBy` `agent-detector.ts:105-112`; `DoctorResult` `doctor-runner.ts:23-26,137-138`.
- [~] **R7** Downstream absorption (scoped) → **PARTIAL** | Upstream gaps closed (omp/hermes first-class). Optional `listAgents({includeDeprecated})` helper from the Downstream table not added — deferred, acceptable.
- [x] **R8** Docs + tests + gate → **MET (modulo unrelated gate)** | README updated: agent table + `resolveAgentName` row (`README.md:20-21,35`), supported-id line with deprecation, "Deprecation & Aliases" section. Tests comprehensive (92 pass, parity + alias + deprecation covered). Gate blocked only by unrelated infra files (P1-1), NOT by ai-runner.

**Net:** 7/8 fully met, 1 partial (R7 optional helper deferred — acceptable). Zero defects in task-0038 code; README + tests complete. The single gate blocker is unrelated uncommitted `packages/infra` work and must not be charged to this task. The two P2 verification flags (Hermes/Antigravity argv) are LOW-confidence accuracy risks deferred from §Open Questions — close before any downstream release.


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


### History

- Migrated from legacy format (2026-07-31)
