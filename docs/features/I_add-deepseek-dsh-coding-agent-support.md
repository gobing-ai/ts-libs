---
schema_version: 1
id: "I"
name: "Add DeepSeek dsh coding agent support"
status: active
priority: P2
tags: []
created_at: "2026-09-11T22:42:28.571Z"
updated_at: "2026-09-11T23:21:41.912Z"
---

# I: Add DeepSeek dsh coding agent support

## Goal

Register DeepSeek's coding agent `dsh` (`@deepseek-ai/dsh`) as a first-class supported agent: `@gobing-ai/ts-ai-runner` gains a `deepseek` shim so downstream projects (spur) can dispatch and detect it headlessly, and `@gobing-ai/ts-llm-jsonl-importer` gains a `deepseek` history source so `$DSH_HOME` session logs import like the other supported coding agents.

Evidence base: source review of `~/tools/deepseek-harness` (0.1.5-rc.2) plus live verification — `dsh --version` → `0.1.5-rc.1`; one-shot dispatch `dsh --profile headless "<task>"` (stderr reasoning, stdout final answer) wrote `~/.dsh/sessions/--*--/session-<uuid>/session.v3.jsonl.zstd`.

## Scope

- In:
    - ai-runner: canonical agent id `deepseek` (binary `dsh`, tier 1); `AgentShim` with help/version/prompt/auth
    - Prompt mapping: `dsh --profile headless <input>`; no headless resume/model/mode flags on this CLI (Codex-style degrade: fresh dispatch; per-invocation `sessionId`/`continue`/`model`/`mode` remain unsupported-byCLI and documented)
    - Registry membership: `AGENT_SHIMS`, `DISPLAY_ORDER`; stable auto-select placement after existing preferred agents
    - Auth command: null (no auth subcommand; credentials resolve via env refs / `~/.dsh`)
    - Importer: built-in source `deepseek` — dirs default `~/.dsh/sessions` (`$DSH_HOME`-aware), per-session `session-*/` subdirs, files `session.v3.jsonl` and `*.jsonl.zstd`
    - Log format: skip header event (first line `type:"session"`); derive records from `user/message` and `assistant/message` events (`{type,seq,time,data}`); session id/`createdAt`/`cwd` from the header line
    - Zstd: decompress `*.jsonl.zstd` via ProcessExecutor + system `zstd` (ts-runtime sanctioned seam; `zstd` ADR-014 boundary; no new dependency), with clear error when `zstd` is missing
    - Torn-tail tolerance: `corruptLinePolicy: 'skip'` on the deepseek source (mirrors `agy`)
    - Unit tests: shim argv/registry, detector mock parse; importer source definition, split/mapper over fixture events (raw + decompressed), header/corrupt-line handling
    - README updates in both packages
- Out:
    - Live network integration smoke against DeepSeek API
    - Session title/compaction/subagent event semantics beyond message derivation
    - Skill-directory doctor checks (dsh reads `~/.agents/skills` natively)
    - Passing dsh advanced flags (bundles, `--patch`, profiles beyond `headless`)
    - New ADR (no boundary change; ProcessExecutor use is the existing sanctioned seam)

## Acceptance Criteria

```gherkin
Feature: Add DeepSeek dsh coding agent support

  @core
  Scenario: R1 — deepseek is a known canonical agent id
    Given the ts-ai-runner agent registry
    When isAgentName("deepseek") and resolveAgentName("deepseek") are checked and detectOne("deepseek") runs against a mocked executor
    Then the id resolves canonically and the shim's version command is `dsh --version`

  @core
  Scenario: R2 — prompt command maps PromptOptions to dsh headless argv
    Given the deepseek AgentShim
    When getPromptCommand is called with input
    Then the command is "dsh" with args ["--profile","headless",<input>]

  @core
  Scenario: R3 — session options degrade without error
    Given PromptOptions with sessionId, continue or model set
    When getPromptCommand is built
    Then the resolved argv is a fresh headless one-shot dispatch with no resume/model flags

  @core
  Scenario: R4 — importer deepseek source finds session logs
    Given $DSH_HOME (or ~/.dsh) with sessions/--<cwd>--/session-<uuid>/
    When the importer scans source deepseek
    Then it discovers session.v3.jsonl and session.v3.jsonl.zstd files under session-* subdirectories

  @core
  Scenario: R5 — zstd session log imports
    Given a session.v3.jsonl.zstd fixture with a session header line plus user/message and assistant/message events
    When the deepseek source import runs
    Then the header line is skipped, message events map to records with role, content, created_at (event time ms → ISO), model/provider when present, and source_record_id derived from message id

  @core
  Scenario: R6 — raw session log imports identically
    Given the same fixture uncompressed as session.v3.jsonl with compression none
    When the deepseek source import runs
    Then the mapped records equal the R5 records except storage artifacts

  @core
  Scenario: R7 — torn tail and unknown events do not abort import
    Given a session log whose last line is truncated and containing an unrelated event type
    When the deepseek source import runs with corruptLinePolicy skip
    Then good message records import and no import error is raised

  @core
  Scenario: R8 — missing zstd binary fails with an actionable error
    Given no zstd executable on PATH
    When a *.jsonl.zstd session file is processed
    Then the import fails with an error naming zstd and the file path

  @quality
  Scenario: R9 — registry and tests meet the repo gate
    Given the final change
    When bun run spur-check and bun run build run
    Then both pass with no suppressions and package READMEs list deepseek/dsh support
```

## Tasks

<!-- AUTO-GENERATED by spur feature refresh -->
| WBS | Task | Status |
| --- | ---- | ------ |
| 0066 | Add deepseek dsh shim to ts-ai-runner | testing |
| 0067 | Add deepseek session source to ts-llm-jsonl-importer | todo |
<!-- END AUTO-GENERATED -->

## Notes

- Review report: `.spur/run/idea-eval-report.md`

## History

- 2026-09-11T23:21:41.912Z backlog → active (system)

