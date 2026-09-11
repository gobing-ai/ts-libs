---
schema_version: 1
name: Add deepseek session source to ts-llm-jsonl-importer
status: todo
template: feature-impl
created_at: 2026-09-11T22:58:21.875Z
updated_at: "2026-09-11T23:01:12.898Z"
feature_id: I

---

## 0067. Add deepseek session source to ts-llm-jsonl-importer

### Background

Captured from `/sp-dev-idea --auto`: `@gobing-ai/ts-llm-jsonl-importer` imports coding-agent history from the `SOURCE_DEFINITIONS` registry (pi/claude/codex/omp/grok/agy/gemini/opencode/antigravity/openclaw) into `history_etl_<source>` tables. DeepSeek's `dsh` sessions are missing, so downstream analytics (spur history) cannot ingest them.

Verified facts (source review of `~/tools/deepseek-harness` + live session inspected on disk):
- Storage root: `$DSH_HOME` or `~/.dsh` (`packages/util/home-paths`); base bundle mounts `session-persistence-jsonl` with `root: ~/.dsh/sessions`.
- Layout: `~/.dsh/sessions/<--normalized-abs-cwd>--/session-<uuid>/` with `session.lock` and `session.v3.jsonl.zstd` (raw `session.v3.jsonl` when `compression: 'none'`).
- Format: line-1 header `{"type":"session","version":3,"id","createdAt","cwd","isSeeded","delegationDepth"}`; then append-only events `{"type","seq","time","data"}`. Message history is derived: `user/message`, `assistant/message` (content array with `text`, `source:{provider,model}`, `usage`), `system/message`. Vocabulary is plugin-extensible (`compaction/*`, `hook/*`, `turn/*`, `session/title`, …).
- Compression: checksummed Zstandard frames (decompressed successfully with the system `zstd` CLI).
- Crash recovery means the last line can be torn (confirmed `corruptLinePolicy` affordance exists for agy, task 0623).

### Requirements

- [ ] R1 (feature I/R4): built-in source `deepseek` discovers `session.v3.jsonl` and `session.v3.jsonl.zstd` under `$DSH_HOME` (or `~/.dsh`) `sessions/<cwd>--/session-*/` directories.
- [ ] R2 (feature I/R5): header event (first line `type:"session"`) is skipped; `user/message` and `assistant/message` events map to records with `role`, `content` (joined text), `created_at` (event `time` ms → ISO), `model`/provider when present, and `source_record_id` derived from the message id; session id/`createdAt`/`cwd` from the header line.
- [ ] R3 (feature I/R6): the same fixture stored uncompressed maps to identical records except storage artifacts.
- [ ] R4 (feature I/R7): truncated tail and unknown event types do not abort the import (`corruptLinePolicy: 'skip'`).
- [ ] R5 (feature I/R8): a `*.jsonl.zstd` file processed without a `zstd` executable on PATH fails with an actionable error naming zstd and the file path.
- [ ] R6 (feature I/R9): unit tests + README for the deepseek source; `bun run spur-check` + `bun run build` pass without suppressions.

### Acceptance Criteria

```gherkin
Feature: Add deepseek session source to ts-llm-jsonl-importer

  @core
  Scenario: R4 — importer deepseek source finds session logs
    Given $DSH_HOME (or ~/.dsh) with sessions/--<cwd>--/session-<uuid>/
    When the importer scans source deepseek
    Then it discovers session.v3.jsonl and session.v3.jsonl.zstd files under session-* subdirectories

  @core
  Scenario: R5 — zstd session log imports
    Given a session.v3.jsonl.zstd fixture with a session header line plus user/message and assistant/message events
    When the deepseek source import runs
    Then the header line is skipped, message events map to records with role, content, created_at, model/provider when present, and source_record_id derived from message id

  @core
  Scenario: R6 — raw session log imports identically
    Given the same fixture uncompressed as session.v3.jsonl
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

  @core
  Scenario: R9 — registry and tests meet the repo gate
    Given the final change
    When bun run spur-check and bun run build run
    Then both pass with no suppressions and the README documents the deepseek source
```

### Q&A

#### Q&A entry — 2026-09-11T22:59Z
- Zstd handling: decompress via ProcessExecutor + system `zstd` (ts-runtime sanctioned seam, ADR-014 boundary) — no new dependency; actionable failure when missing (`ponytail:` upgrade path — bundled WASM zstd only if a no-system-zstd environment materializes).
- Message derivation limited to `user/message` + `assistant/message` (matches every observed session); unknown event types tolerated, not extended.
- Pre-release format (`version: 3` in header) may shift; header-skip keeps the mapper version-agnostic for future v4.

### Design

Approach: extend the existing registry pattern in `packages/llm-jsonl-importer/src/`.

- `types.ts`: add deepseek to `LlmJsonlSource` union.
- `sources.ts`: `deepseek: customSourceDefinition(...)` with:
  - dirs `['.dsh/sessions']` (+ `$DSH_HOME` env override honored by the dir-resolution layer, mirroring how other sources express home-relative paths); recursive scan into `session-*` dirs; glob `session.v3.jsonl*`.
  - `corruptLinePolicy: 'skip'` (torn tails from crash recovery; same rationale as agy/task 0623).
  - split fn (`dshSplit`): parse each line; skip `type:"session"` header; emit records only for `type:"user/message"` / `type:"assistant/message"`; tolerate unknown types.
  - field map (`DSH_FIELD_MAP`) + zod `DSH_SCHEMA`: `source_record_id` ← `data.message.id` (fallback hash of seq+content), `created_at` ← event `time` (epoch ms → ISO), `content` ← joined `data.message.content[].text`, `role` ← `data.message.role`, `model` ← `data.message.source.model`, `provider` passthrough.
- Decompression: pre-line stage for `*.jsonl.zstd` — stream file bytes through ProcessExecutor running `zstd -dc <path>` to stdout, reading the event stream; when `zstd` is absent, fail the record/file with an error naming zstd + file path. No new package dependency.
- Tests (`tests/`): fixture session log (header + messages + unknown event + torn tail) in raw and `.zstd` form; assert record equality, header skip, torn-tail skip, missing-zstd error text.
- README: document the deepseek source + zstd prerequisite.

Tradeoff: derives only chat messages; titles/usage/compaction events are dropped (extend later if needed). `zstd -dc` assumes system zstd available — checked first.

### Plan

1. Fixture-first: create tests/fixtures dsh session log (header + user/assistant messages + unknown event + truncated tail), raw + zstd; write failing source tests — red.
2. Add `deepseek` to `LlmJsonlSource`; add `dshSplit`/`DSH_FIELD_MAP`/`DSH_SCHEMA` in mappers; register in `SOURCE_DEFINITIONS` with `corruptLinePolicy: 'skip'` — green.
3. Add zstd decode stage via ProcessExecutor + system `zstd`; missing-binary error test — green.
4. README + lint; `bun run build`, targeted `bun test packages/llm-jsonl-importer`.
5. Final: `bun run spur-check`, review diff vs AC.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- Feature I (Add DeepSeek dsh coding agent support), sibling task 0066 (ai-runner shim).
- Review report: `.spur/run/idea-eval-report.md` (evidence: `~/tools/deepseek-harness` source, live one-shot session).
- dsh CLI help observed: `dsh --profile headless --help` (only task + `-h`).
- Precedent: docs/features/A1_add-grok-coding-agent-to-ts-ai-runner.md.

### History

- 2026-09-11T23:01:12.898Z backlog → todo (system)

