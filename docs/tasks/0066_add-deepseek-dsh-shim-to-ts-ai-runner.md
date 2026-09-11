---
schema_version: 1
name: Add deepseek dsh shim to ts-ai-runner
status: todo
template: feature-impl
created_at: 2026-09-11T22:58:20.090Z
updated_at: "2026-09-11T23:01:14.772Z"
feature_id: I

---

## 0066. Add deepseek dsh shim to ts-ai-runner

### Background

Captured from `/sp-dev-idea --auto`: DeepSeek's coding agent `dsh` ships and its source lives at `~/tools/deepseek-harness`. Downstream projects (spur) already consume `@gobing-ai/ts-ai-runner` for detection and headless prompt dispatch of coding agents (claude/codex/gemini/pi/opencode/antigravity-cli/openclaw/hermes/omp/grok — A1 precedent for grok). `dsh` is missing, so spur cannot dispatch or detect it.

Verified facts (source review + live run):
- bin `dsh` (`@deepseek-ai/dsh`), `dsh --version` → `0.1.5-rc.1`; boot model `dsh --profile <name>`.
- Headless one-shot: `dsh --profile headless "<task>"` — streams reasoning to stderr, prints the final assistant message to stdout, exits (verified; wrote a real session file under `~/.dsh/sessions`).
- Headless app accepts only the positional task + `-h`: no resume/model/mode flags.
- No auth subcommand; credentials resolve via env references / `~/.dsh` storage.

### Requirements

- [ ] R1: `deepseek` becomes a known canonical agent id resolved via the shim registry (`AGENT_SHIMS`, `DISPLAY_ORDER`); binary `dsh`, tier 1.
- [ ] R2 (feature I/R1): registry check — `isAgentName("deepseek")` and `resolveAgentName("deepseek")` accept; `detectOne` targets `dsh --version`.
- [ ] R3 (feature I/R2): `getPromptCommand({input})` → `{command:"dsh", args:["--profile","headless",<input>]}`.
- [ ] R4 (feature I/R3): `sessionId`/`sessionDir`/`continue`/`model` set → fresh headless one-shot argv, no resume/model flags, no error.
- [ ] R5 (feature I/R1+R9): detector parses `dsh --version` output (plain semver `0.1.5-rc.1`) with mocked executor; auth command is null.
- [ ] R6 (feature I/R9): package README supported-agents list includes dsh; `bun run spur-check` + `bun run build` pass without suppressions.

### Acceptance Criteria

```gherkin
Feature: Add deepseek dsh shim to ts-ai-runner

  @core
  Scenario: R1 — deepseek is a known canonical agent id
    Given the ts-ai-runner agent registry
    When isAgentName("deepseek") and resolveAgentName("deepseek") are checked and AgentDetector.detectOne("deepseek") runs against a mock returning exit 0 and stdout "0.1.5-rc.1" for `dsh --version`
    Then the id resolves canonically to "deepseek", installed is true, version is 0.1.5-rc.1, and getAuthCommand returns null

  @core
  Scenario: R2 — prompt command maps PromptOptions to dsh headless argv
    Given the deepseek AgentShim
    When getPromptCommand is called with input "run the tests"
    Then the command is "dsh" with args ["--profile","headless","run the tests"]

  @core
  Scenario: R3 — session options degrade without error
    Given PromptOptions with sessionId, sessionDir, continue or model set
    When getPromptCommand is built
    Then the argv is a fresh one-shot headless dispatch with no resume/model flags and no error

  @core
  Scenario: R9 — registry and tests meet the repo gate
    Given the final change
    When bun run spur-check and bun run build run
    Then both pass with no suppressions and the README lists dsh
```

### Q&A

#### Q&A entry — 2026-09-11T22:58Z
- Agent id: `deepseek` (descriptive, matches provider/model naming seen in session events; binary remains `dsh`). No aliases.
- Prompt mapping uses `--profile headless` (the CLI's supported one-shot surface). No global `-p`-style flag exists, so none invented.
- Session/model options degrade Codex-style (fresh dispatch, documented) — dsh headless has no resume/model flags at 0.1.5.
- Deferred: dsh version output contains only the plain semver; attach format commentary when the CLI changes.

### Design

Approach: follow the A1 grok shim pattern exactly.

- `packages/ai-runner/src/agents/shims.ts`: add `'deepseek'` to `AgentName`; new `dshShim: AgentShim` (`name:'deepseek'`, `command:'dsh'`, `tier:1`):
  - `getHelpCommand`: `dsh --help`; `getVersionCommand`: `dsh --version`.
  - `getPromptCommand(options)`: base args `['--profile','headless', options.input ?? '']`. If `options.sessionId !== undefined || sessionDir !== undefined || continue === true || model !== undefined` → doc-comment WHY (headless app takes only task + `-h`; no flags at 0.1.5-rc) and return the same fresh dispatch (no error, no extra flags). `mode`/`workspace`/`timeoutMs`: no CLI flag — best-effort ignored, mirrors antigravity comment pattern.
  - `getAuthCommand`: `null` (no auth subcommand; credentials via env refs/`~/.dsh`).
- Register in `AGENT_SHIMS` and `DISPLAY_ORDER` after grok (stable auto-select tail position, matching A1).
- Version parse: existing `VERSION_PATTERN` regex already matches `0.1.5-rc.1` (`\d+\.\d+(?:\.\d+)?`) — no detector change expected beyond the shim entry; verify with a mock.

Tradeoff: no `--continue` reward; the headless profile is a one-shot surface. Upgrade path: wire flags when dsh ships them (keep the comment naming the version).

### Plan

1. Extend unit test expectations first (registry membership + shim argv + degrades + detector mock) — red.
2. Add `dshShim` + `'deepseek'` to `AgentName`, `AGENT_SHIMS`, `DISPLAY_ORDER` — green.
3. Update `packages/ai-runner/README.md` supported-agents table/list.
4. `bun run lint` (biome + tsc per package), `bun run build`, targeted `bun test packages/ai-runner`.
5. Final: `bun run spur-check`, review diff vs AC.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- Feature I (Add DeepSeek dsh coding agent support), sibling task 0067 (importer source).
- Review report: `.spur/run/idea-eval-report.md` (evidence: `~/tools/deepseek-harness` source, live one-shot session).
- dsh CLI help observed: `dsh --profile headless --help` (only task + `-h`).
- Precedent: docs/features/A1_add-grok-coding-agent-to-ts-ai-runner.md.

### History

- 2026-09-11T23:01:14.772Z backlog → todo (system)

