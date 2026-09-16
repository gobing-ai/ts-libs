---
schema_version: 1
name: Add deepseek session source to ts-llm-jsonl-importer
status: done
template: feature-impl
created_at: 2026-09-11T22:58:21.875Z
updated_at: "2026-09-16T19:43:40.604Z"
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

- [x] R1 (feature I/R4): built-in source `deepseek` discovers `session.v3.jsonl` and `session.v3.jsonl.zstd` under `$DSH_HOME` (or `~/.dsh`) `sessions/<cwd>--/session-*/` directories.
- [x] R2 (feature I/R5): the header event (first line `type:"session"`) is retained as one `history_message` metadata row (`role=meta`, `disposition=meta`) carrying session id, `cwd` and `createdAt`; `user/message` and `assistant/message` events map to conversational records with `role`, `content` (joined text), `created_at` (event `time` ms → ISO), `model`/provider when present, and `source_record_id` derived from the message id.
- [x] R3 (feature I/R6): the same fixture stored uncompressed maps to identical records except storage artifacts.
- [x] R4 (feature I/R7): truncated tail and unknown event types do not abort the import (`corruptLinePolicy: 'skip'`).
- [x] R5 (feature I/R8): a `*.jsonl.zstd` file processed without a `zstd` executable on PATH fails with an actionable error naming zstd and the file path.
- [x] R6 (feature I/R9): unit tests + README for the deepseek source; `bun run spur-check` + `bun run build` pass without suppressions.

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
    Then the header line is retained as one history_message metadata row (role=meta, disposition=meta) carrying session id, cwd and creation time, message events map to conversational rows with role, content, created_at, model/provider when present, and source_record_id derived from message id

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
- Pre-release format (`version: 3` in header) may shift; header-skip keeps the mapper version-agnostic for future v4. *(Superseded 2026-09-16 by the clarification below: the shipped mapper retains the `type:"session"` header as one `meta` row rather than skipping it.)*

#### Q&A entry — 2026-09-16T17:35:37.589Z

**Clarification (2026-09-16, task 0068 C01).** The original R2 and AC R5 wording said the session header line "is skipped". That wording was **wrong about what shipped**, and it is superseded here; the requirement checkbox and the PASS receipt in Testing are preserved unchanged as the historical record — this note is the correction, not a re-run.

- **What the code does** (`packages/llm-jsonl-importer/src/mappers.ts`, `dshSplit`): the `type:"session"` header is persisted as one `history_message` row with `role=meta`, `record_type=session`, `disposition=meta`, carrying session id, `cwd` and `createdAt`; `user/message` / `assistant/message` events become conversational `keep` rows. The fixture's header + two messages therefore import as three records (`packages/llm-jsonl-importer/tests/deepseek-importer.test.ts`), and `importedRecords` counts the metadata row too — no consumer-side filtering or counting change exists or is authorized.
- **Authority:** feature I's Scope and AC R5 now state the retained-metadata-row contract (amended 2026-09-16). R2, AC R5 and the Design bullets here were aligned to that amended AC.
- **Not chosen:** literal header removal. It would drop `cwd`/creation-time provenance and is a behavior change requiring its own scope and decision; it was explicitly not selected.

### Design

Approach: extend the existing registry pattern in `packages/llm-jsonl-importer/src/`.

- `types.ts`: add deepseek to `LlmJsonlSource` union.
- `sources.ts`: `deepseek: customSourceDefinition(...)` with:
  - dirs `['.dsh/sessions']` (+ `$DSH_HOME` env override honored by the dir-resolution layer, mirroring how other sources express home-relative paths); recursive scan into `session-*` dirs; glob `session.v3.jsonl*`.
  - `corruptLinePolicy: 'skip'` (torn tails from crash recovery; same rationale as agy/task 0623).
  - split fn (`dshSplit`): parse each line; emit one metadata row for the `type:"session"` header (session identity, `cwd`, `createdAt`); emit conversational records for `type:"user/message"` / `type:"assistant/message"`; tolerate unknown types.
  - field map (`DSH_FIELD_MAP`) + zod `DSH_SCHEMA`: `source_record_id` ← `data.message.id` (fallback hash of seq+content), `created_at` ← event `time` (epoch ms → ISO), `content` ← joined `data.message.content[].text`, `role` ← `data.message.role`, `model` ← `data.message.source.model`, `provider` passthrough.
- Decompression: pre-line stage for `*.jsonl.zstd` — stream file bytes through ProcessExecutor running `zstd -dc <path>` to stdout, reading the event stream; when `zstd` is absent, fail the record/file with an error naming zstd + file path. No new package dependency.
- Tests (`tests/`): fixture session log (header + messages + unknown event + torn tail) in raw and `.zstd` form; assert record equality, the header metadata row, torn-tail skip, missing-zstd error text.
- README: document the deepseek source + zstd prerequisite.

Tradeoff: derives only chat messages; titles/usage/compaction events are dropped (extend later if needed). `zstd -dc` assumes system zstd available — checked first.

### Plan

1. Fixture-first: create tests/fixtures dsh session log (header + user/assistant messages + unknown event + truncated tail), raw + zstd; write failing source tests — red.
2. Add `deepseek` to `LlmJsonlSource`; add `dshSplit`/`DSH_FIELD_MAP`/`DSH_SCHEMA` in mappers; register in `SOURCE_DEFINITIONS` with `corruptLinePolicy: 'skip'` — green.
3. Add zstd decode stage via ProcessExecutor + system `zstd`; missing-binary error test — green.
4. README + lint; `bun run build`, targeted `bun test packages/llm-jsonl-importer`.
5. Final: `bun run spur-check`, review diff vs AC.

### Solution

#### Change map

- `packages/llm-jsonl-importer/src/types.ts:17` — `'deepseek'` added to the `LlmJsonlSource` union.
- `packages/llm-jsonl-importer/src/mappers.ts`
  - `dshSplit` (approx. :1462) — event mapper: `type:"session"` header → one meta row carrying `cwd` (session bookkeeping, gemini-session-row precedent); `user/message` / `assistant/message` → `history_message` keep rows (role, joined-text `content_text`, epoch-ms `time` → ISO `ts`, `source.model`, `usage` tokens); every other plugin-extensible event type returns zero entries (tolerated, task 0067 R4). `DSH_FIELD_MAP` / `DSH_SCHEMA` identity passthrough.
  - `dshSplit` R2 fix (verify remediation): `data.message.id` (fallback `data.id`) is emitted as `source_record_id` on chat-message records when present — it rides the normalized record into the `record_hash`, so identity derives from the message id; absent id keeps the key out and the record hash falls back to the importer's line-derived identity unchanged. `DSH_FIELD_MAP` passes `source_record_id` through (`MESSAGE_MAPPER_KEYS.concat(['source_record_id'])`).
  - `sessionIdFromSourcePath` — `deepseek` branch extracts the `session-<uuid>` dir identity (stateless; message events carry no session id).
- `packages/llm-jsonl-importer/src/jsonl-importer-dao.ts` — `source_record_id` added to `TYPED_IGNORED_KEYS` (the `split_index` precedent: identity-relevant, hashed, not a `history_message` column — never persisted).
- `packages/llm-jsonl-importer/src/sources.ts:224` — `deepseek` registry entry: `customSourceDefinition` with roots `['.dsh/sessions']`, patterns `['session.v3.jsonl', 'session.v3.jsonl.zstd']`, `corruptLinePolicy: 'skip'` (torn crash tails, same rationale as agy/task 0623).
- `packages/llm-jsonl-importer/src/zstd.ts` — new `zstdDecompress(file)`: checksummed session logs decompress through the system `zstd -dc` CLI (ADR-014 ProcessExecutor seam, no new dependency); missing executable (null exit code) or non-zero exit raises an actionable `HistoryImportError` naming zstd + the file path. ponytail: buffered; swap to `runStreaming` stdout piping if live sessions regularly exceed ~100 MB decompressed.
- `packages/llm-jsonl-importer/src/importer.ts`
  - `readLines` — `.jsonl.zstd` files decompress through `zstdDecompress` before line parsing; all existing checkpointing/dedup/skip semantics apply unchanged to the decompressed stream.
  - `discoverFiles` — `$DSH_HOME` override replaces the `~/.dsh` storage root when set (`<DSH_HOME>/sessions`), R1.
- `packages/llm-jsonl-importer/src/index.ts` — `zstdDecompress` exported.
- `packages/llm-jsonl-importer/README.md` + `tests/tables.test.ts` (16-table manifest) updated.

#### Rationale

- Mapper shape follows the seven existing custom-split sources exactly (identity field maps + passthrough zod + typed `history_message` records), not the alternate `history_etl_*` generic path — no second convention.
- Only chat events map dual-rows; titles/usage-as-meta/compaction are deliberately dropped (extend later if downstream analytics need them).
- R2 identity: the typed `history_message` contract has no `source_record_id` column, so the message id participates in identity through the `record_hash` input (hashed, ignored at insert) — the same seam `split_index` already uses; no schema change, no second convention.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/llm-jsonl-importer/src/sources.ts:220-233` — deepseek registry roots ['.dsh/sessions'], patterns ['session.v3.jsonl','session.v3.jsonl.zstd']; `packages/llm-jsonl-importer/src/importer.ts:650-653` — $DSH_HOME replaces ~/.dsh storage root; tests `tests/deepseek-importer.test.ts:98,110` (discovery + $DSH_HOME injection), passing this run |
| R2 | MET | `packages/llm-jsonl-importer/src/mappers.ts:1462-1526` — header (type:"session") → meta row carrying cwd; user/assistant/message events → history_message rows with role, joined content_text, ts (epoch ms → ISO, :1512), model from source.model; remediation: `data.message.id`/`data.id` → source_record_id (`:1505-1511`), passthrough `:2180`, hashed-not-persisted `packages/llm-jsonl-importer/src/jsonl-importer-dao.ts:101-103`; tests :192-211 passing this run |
| R3 | MET | test `packages/llm-jsonl-importer/tests/deepseek-importer.test.ts:147-168` — raw vs zstd fixture record equality excluding storage artifacts; passing this run |
| R4 | MET | `packages/llm-jsonl-importer/src/sources.ts:209,233` — corruptLinePolicy 'skip'; `packages/llm-jsonl-importer/src/mappers.ts:1505-1511` — unknown event types return zero entries; test :171-178 torn tail + unrelated event, no import error; passing this run |
| R5 | MET | `packages/llm-jsonl-importer/src/zstd.ts:19-29` — null exit code → HistoryImportError "zstd decompression failed for <file>: the zstd executable is required on PATH..." naming zstd and the file; non-zero → zstd exit context; tests `tests/zstd.test.ts` missing-binary + corrupt-payload cases passing this run |
| R6 | MET | `README.md:24` documents the deepseek source + zstd prerequisite; tables.test.ts 16-table manifest includes deepseek-scanning rows; bun run spur-check "All 2 rules passed" and bun run build exit 0, both fresh this run; no suppressions in src/ |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| R4 — importer deepseek source finds session logs | MET | test | tests/deepseek-importer.test.ts:98,110 (336 pass / 0 fail, fresh run) — session.v3.jsonl and .zstd discovered under session-* dirs with $DSH_HOME override honored; sources.ts:220-233 |
| R5 — zstd session log imports | MET | test | tests/deepseek-importer.test.ts:120-145 — header line skipped to meta row; user/assistant events map role/content/created_at/model/source_record_id; tests/zstd.test.ts real decompression through system zstd; mappers.ts:1505-1512 |
| R6 — raw session log imports identically | MET | test | tests/deepseek-importer.test.ts:147-168 — stripStorage(rawRecords) equals stripStorage(zstdRecords), fresh run |
| R7 — torn tail and unknown events do not abort import | MET | test | tests/deepseek-importer.test.ts:171-178 (passing, no import error); corruptLinePolicy 'skip' at sources.ts:232-234; unknown-type drop at mappers.ts:1489-1490 |
| R8 — missing zstd binary fails with an actionable error | MET | test | tests/zstd.test.ts missing-binary case (null exit code) → HistoryImportError naming zstd and the file path; zstd.ts:19-31 |
| R9 — registry and tests meet the repo gate | MET | command | Fresh: bun run spur-check "All 2 rules passed"; bun run build exit 0 incl. ts-llm-jsonl-importer; README.md:24 documents deepseek incl. zstd prerequisite; no suppressions |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

#### Review Report — 0067 (remediation re-review)

**Scope:** fresh delta since last digest — `mappers.ts` dshSplit source_record_id emission + `jsonl-importer-dao.ts` TYPED_IGNORED_KEYS + two new R2 tests; brief re-check of all R1–R6 and the open P3/P4 advisories
**Dimensions:** functional, security, efficiency, correctness, usability, architecture
**Verdict:** PASS

##### Findings (ranked)

| # | Priority | Dimension | Finding | Location |
|---|----------|-----------|---------|----------|
| 1 | P3 (minor) | correctness | Carried over, not fixed (accepted disposition): importing both raw + `.zstd` representations of the same session double-stores rows because `record_hash` includes `sourceFile`. Fix + new message-id now make rows converge on `data.message.id` only when the id is present and line counts align; with no id (or different line offsets after torn tails) hashes still diverge. Low likelihood; tolerate. | `packages/llm-jsonl-importer/src/importer.ts:249-255` |
| 2 | P4 (advisory) | functional | R2 remediation verified: `dshSplit` emits `source_record_id` from `msg.id`/`data.id` on chat events; `DSH_FIELD_MAP` passes it through; `TYPED_IGNORED_KEYS` hashes it at insert without persisting; both remediation tests assert present-id mapping and absent-id fallback. | `packages/llm-jsonl-importer/src/mappers.ts:1505-1511`, `packages/llm-jsonl-importer/src/jsonl-importer-dao.ts:103` |
| 3 | P4 (advisory) | architecture | Buffering ceiling for `zstdDecompress` remains documented (`ponytail` note); unchanged since last review. | `packages/llm-jsonl-importer/src/zstd.ts` |

Fresh verification this run: package `bun test` 336 pass / 0 fail (1543 expect calls); root `bun run spur-check` 2240 pass / 0 fail, pre-check "All 49 rules passed", post-check "All 2 rules passed"; `bun run build` exit 0 — no suppressions.

##### Functional Traceability

| Req | Status | Evidence |
|-----|--------|----------|
| R1 | MET | `packages/llm-jsonl-importer/src/sources.ts:224` deepseek registry (both file patterns, `corruptLinePolicy:'skip'`); `$DSH_HOME` override in `importer.ts` discoverFiles; discovery test passing |
| R2 | MET | `packages/llm-jsonl-importer/src/mappers.ts:1462-1526` header → meta row, user/assistant → keep rows with role/ts/model; message id → `source_record_id` (remediation, tests at `packages/llm-jsonl-importer/tests/deepseek-importer.test.ts:192-211`) |
| R3 | MET | raw-vs-zstd record equality test passing |
| R4 | MET | torn tail + unknown events test passing |
| R5 | MET | missing-zstd actionable error test + `zstd.test.ts` 3 tests passing |
| R6 | MET | README updated, 16-table manifest, spur-check + build green this run |

**Next:** Re-review closes the pipeline gate; disposition finding #1's accepted state in Solution prose if desired. No blockers.
### References

- Feature I (Add DeepSeek dsh coding agent support), sibling task 0066 (ai-runner shim).
- Review report: `.spur/run/idea-eval-report.md` (evidence: `~/tools/deepseek-harness` source, live one-shot session).
- dsh CLI help observed: `dsh --profile headless --help` (only task + `-h`).
- Precedent: docs/features/A1_add-grok-coding-agent-to-ts-ai-runner.md.

### History

- 2026-09-11T23:01:12.898Z backlog → todo (system)
- 2026-09-11T23:35:40.992Z todo → wip (system)
- 2026-09-11T23:47:11.310Z wip → testing (system)
- 2026-09-11T23:47:11.807Z testing → done (system)

