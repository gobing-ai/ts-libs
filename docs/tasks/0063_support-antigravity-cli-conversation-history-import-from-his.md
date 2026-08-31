---
schema_version: 1
name: "Support Antigravity CLI conversation history import from history.jsonl and conversation databases in ts-llm-jsonl-importer"
status: done
template: standard
created_at: 2026-08-31T15:33:47.925Z
updated_at: "2026-08-31T17:34:06.505Z"
feature_id: E
---

## 0063. Support Antigravity CLI conversation history import from history.jsonl and conversation databases in ts-llm-jsonl-importer

### Background

Follow-up to verify and resolve Antigravity CLI (`agy`) conversation history loading in
`@gobing-ai/ts-llm-jsonl-importer`.

#### Verified ground truth (re-checked 2026-08-31 against the working tree and a live `~/.gemini/antigravity-cli` install)

An earlier idea evaluation (`.spur/run/1A9E3E71-8C06-4397-81C8-40D7CE31FD48-idea-eval-report.md`)
and the first draft of this task both mis-stated the gap. The premises below are the corrected,
evidence-backed baseline. **The Design freezes on this table, not on the earlier draft.**

| Earlier claim | Ground truth (2026-08-31) | Verdict |
| --- | --- | --- |
| `brain/` holds zero JSONL; the scanner discovers 0 files and agy history is silently skipped | `~/.gemini/antigravity-cli/brain` holds **1,174** `*.jsonl` (153 `transcript.jsonl`, 148 `transcript_full.jsonl`, 873 `NNNNNNNN.jsonl`). agy already imports brain transcripts today | **FALSE** |
| `agySplit` cannot parse numeric millisecond epochs | `timestampOf` (`src/mappers.ts:1619-1624`) already converts numeric epochs to ISO-8601, and `agySplit:874` already passes `raw.timestamp` into it | **FALSE — no change needed** |
| `AGY_SCHEMA` must gain optional `display`/`conversationId`/`workspace`/numeric `timestamp` | `AGY_SCHEMA = z.object({}).passthrough()` (`src/mappers.ts:1706,1717`) — it already accepts every field | **FALSE — no-op** |
| `AGY_FIELD_MAP` must gain `display`, `conversationId`, `workspace` | `AGY_FIELD_MAP = identityFieldMap(MESSAGE_MAPPER_KEYS + TOOL_CALL_MAPPER_KEYS)` keys **output columns**; `normalizeRecord` (`src/importer.ts:592-605`) runs on the mapper's *output* record, never on `raw` | **FALSE — the edit would be wrong, not just useless** |
| `history.jsonl` prompt records carry `type: "slash_command"` | Over 977 records: `type` **absent 769**, `slash_command` **204**, `shell` **4**. A third type exists and the earlier design did not handle it | **PARTIAL** |
| `conversationId` identifies the session | Present on **888/977**; the 89 without it are the first prompt of a conversation (the id does not exist yet at prompt time) | **PARTIAL** |
| Title promises "and conversation databases" | 227 `.db`/`.pb` files under `conversations/`, but the earlier Scope excluded them and no requirement covered them | **SCOPE CONFLICT — resolved as a non-goal below** |

#### What is actually broken

1. **`history.jsonl` is never discovered (the only functional gap).**
   `SOURCE_DEFINITIONS['agy'].defaultRoots` is `['.gemini/antigravity-cli/brain']`
   (`src/sources.ts:193-207`), one level *below* `~/.gemini/antigravity-cli/history.jsonl`.
   `walkDir` (`packages/runtime/src/fs.ts:64`) recurses, so raising the root one level both keeps
   every brain transcript and picks up `history.jsonl`. The whole `antigravity-cli` tree contains
   exactly **one** `*.jsonl` outside `brain/` — `history.jsonl` itself — so widening the root
   admits no junk.

2. **`agySplit` degrades history-shaped records.** `history.jsonl` records look like
   `{display, timestamp, workspace, conversationId?, type?}` — no `content`, no `session_id`,
   no `step_index`. Today: `explicitSessionId` (`mappers.ts:870`) ignores `conversationId` →
   `session_id = 'unknown'`; the `default` branch with an empty `recordType` yields
   `role = 'unknown'`, `disposition = 'unknown'`, `content_text = null`; `cwd` is hard-coded
   `null` (`mappers.ts:948`); and `seq` is `0` for all 977 records, erasing intra-session order.

3. **`display` is a safe discriminator.** Across a 4,463-record transcript sample, `display`
   appears **0** times and `type` + `step_index` appear on every record. Branching on
   `raw.display !== undefined` cannot collide with the legacy transcript path.

4. **Idempotence needs no new code.** `recordHash = sha256({source, sourceFile, sourceLine,
   splitIndex, record})` (`src/importer.ts:234-240`) is line-anchored, and `history.jsonl` is
   append-only — R6 is already satisfied by construction and only needs a regression test.

#### Scope

- **In scope**
  - `src/sources.ts` — raise `SOURCE_DEFINITIONS['agy'].defaultRoots` to `.gemini/antigravity-cli`.
  - `src/mappers.ts` — `agySplit` only: history-shape branch, `conversationId` session resolution,
    `workspace` → `cwd`, `sourceLine` → `seq` fallback.
  - `tests/mappers.test.ts`, `tests/importer.test.ts`, `tests/forensic-contract.test.ts`.
  - `README.md` source-key note.
- **Non-goals (explicit)**
  - Importing `conversations/<id>.db` / `.pb` trajectory stores or `conversation_summaries.db`.
    Deferred to a **separate task** modelled on `src/opencode-importer.ts`; open it only when a
    consumer needs tool-call/step-level agy forensics. The `history.jsonl` prompt index does not
    depend on it. (Resolves the title-vs-scope conflict above; the task title is left unchanged
    because `spur task update` has no `--name` flag.)
  - Forward-filling the 89 records that lack `conversationId` (see Q&A).
  - Any change to `AGY_SCHEMA`, `AGY_FIELD_MAP`, `timestampOf`, `corruptLinePolicy`, or to any
    sibling package.

### Requirements

- [x] R1. **Discovery root** — `SOURCE_DEFINITIONS['agy'].defaultRoots` is exactly
  `['.gemini/antigravity-cli']` (the `/brain` suffix is **removed**, not added to). `filePatterns`
  stays `['*.jsonl']`. Scanning a home directory that contains both
  `.gemini/antigravity-cli/history.jsonl` and `.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl`
  discovers **both**.

- [x] R2. **History-shape classification** — in `agySplit`, a record with `raw.display !== undefined`
  is mapped as a user prompt: `role = 'user'`, `disposition = 'keep'`,
  `record_type = String(raw.type ?? '') || 'USER_INPUT'`, `content_text = raw.display`. This one
  branch covers all three observed shapes — absent `type`, `'slash_command'`, and `'shell'` — and
  any future `type` value the producer adds.

- [x] R3. **Session, cwd, and ordering**
  - `session_id` resolves from `s(raw.session_id, raw.conversation_id, raw.conversationId)`, then
    the brain-path UUID, then `'unknown'`.
  - `cwd` resolves from `s(raw.workspace, raw.cwd) ?? null` for **every** agy record (additive:
    legacy transcripts carry neither field and keep `cwd = null`).
  - `seq` falls back to `context.sourceLine` when neither `raw.seq` nor `raw.step_index` is a
    number, so history records keep file order instead of collapsing to `0`
    (same fallback `geminiSplit` already uses).

- [x] R4. **Backward compatibility** — legacy transcript records (`USER_INPUT`, `ASK_QUESTION`,
  `PLANNER_RESPONSE`, `ERROR_MESSAGE`, `RUN_COMMAND`, `VIEW_FILE`, `GREP_SEARCH`,
  `LIST_DIRECTORY`, `READ_URL_CONTENT`, `CODE_ACTION`, `INVOKE_SUBAGENT`, `CONVERSATION_HISTORY`,
  `CHECKPOINT`, `GENERIC`, and the unknown-type `default` branch) produce byte-identical output to
  the pre-change mapper, including `PLANNER_RESPONSE.tool_calls[]` → `history_tool_call` rows.
  Existing `agySplit` tests pass unmodified.

- [x] R5. **Contract invariant** — every transformed history record inserts into `history_message`
  without a Zod or DDL failure: `session_id`, `seq`, `role`, `record_type`, `disposition`,
  `provenance` are all non-null, and `provenance = 'ambient'`.

- [x] R6. **Idempotence** — a second `incremental` import of an unchanged `history.jsonl` reports
  `importedRecords = 0` and `skippedDuplicates = processedLines`. This is expected to need **no
  production change** (the record hash is already line-anchored); the requirement is met by a
  regression test that would fail if the hash inputs ever stop being line-anchored.

- [x] R7. **Corrupt-line resilience** — `corruptLinePolicy: 'skip'` on `agy` is left in place
  (task 0623 rationale) so a torn tail append in `history.jsonl` never aborts the import.

- [x] R8. **Tests** — `tests/mappers.test.ts` covers the four history shapes (bare `display`,
  `slash_command`, `shell`, `display` without `conversationId`), `cwd` extraction, numeric-epoch
  `ts`, and `seq` from `sourceLine`; `tests/importer.test.ts` covers discovery of
  `.gemini/antigravity-cli/history.jsonl` alongside a brain transcript, plus the R6 incremental
  re-import; `tests/forensic-contract.test.ts:203` is updated to the new `defaultRoots` value.

- [x] R9. **Documentation** — `packages/llm-jsonl-importer/README.md` states what the `agy` source
  scans (`~/.gemini/antigravity-cli`, covering both `history.jsonl` and `brain/**` transcripts) and
  notes that conversation `.db` stores are not imported.

- [x] R10. **Verification gate** — `bun run spur-check` and `bun run build` exit 0 with no skipped
  tests and no new `biome-ignore`.

**Out of scope / non-goals:** conversation `.db`/`.pb` import; forward-filling absent
`conversationId`; edits to `AGY_SCHEMA`, `AGY_FIELD_MAP`, `timestampOf`, or any sibling package.

### Acceptance Criteria

```gherkin
Feature: 0063 — Antigravity CLI history.jsonl import

  Scenario: R1 — the widened root discovers history.jsonl and brain transcripts together
    Given a home directory containing ".gemini/antigravity-cli/history.jsonl"
      And a file ".gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl"
    When runJsonlImport is invoked for source "agy" with no explicit files
    Then both files are discovered and processed
      And importedRecords is greater than 0
      And getSourceDefinition("agy").defaultRoots equals [".gemini/antigravity-cli"]

  Scenario: R2 — a bare display record maps to a kept user prompt
    Given the record {"display":"Refactor the database adapter","timestamp":1779224635930,"workspace":"/Users/robin/xprojects/spur","conversationId":"cb06215b-964d-4799-86d1-6ca8cb125a40"}
    When agySplit is invoked with sourceLine 7
    Then it produces exactly 1 history_message entry and 0 history_tool_call entries
      And session_id is "cb06215b-964d-4799-86d1-6ca8cb125a40"
      And role is "user" and disposition is "keep" and record_type is "USER_INPUT"
      And content_text is "Refactor the database adapter"
      And cwd is "/Users/robin/xprojects/spur"
      And seq is 7
      And ts is "2026-05-19T21:03:55.930Z"
      And provenance is "ambient"

  Scenario: R2 — a slash_command record keeps its producer type as record_type
    Given the record {"display":"/rd3-dev-run 0125 --auto --verify","timestamp":1779226019890,"workspace":"/Users/robin/xprojects/spur","conversationId":"eaad556c-d6e3-400c-af66-b819e05637a9","type":"slash_command"}
    When agySplit is invoked
    Then role is "user" and disposition is "keep" and record_type is "slash_command"
      And content_text is "/rd3-dev-run 0125 --auto --verify"

  Scenario: R2 — a shell record is classified by the same branch, not a special case
    Given the record {"display":"git status","timestamp":1779226019890,"workspace":"/tmp/wt","conversationId":"eaad556c-d6e3-400c-af66-b819e05637a9","type":"shell"}
    When agySplit is invoked
    Then role is "user" and disposition is "keep" and record_type is "shell"
      And content_text is "git status"

  Scenario: R3 — a display record without conversationId falls back to unknown
    Given the record {"display":"go ahead","timestamp":1779223942119,"workspace":"/Users/robin/xprojects/spur"}
      And a sourceFile of ".gemini/antigravity-cli/history.jsonl" that yields no brain UUID
    When agySplit is invoked
    Then session_id is "unknown"
      And role is "user" and disposition is "keep"

  Scenario: R4 — legacy transcript records are unchanged
    Given the record {"step_index":5,"type":"PLANNER_RESPONSE","session_id":"legacy-session-123","created_at":"2026-08-15T12:00:00.000Z","content":"I will inspect the files","tool_calls":[{"name":"view_file","input":{"AbsolutePath":"/tmp/test.ts"}}]}
    When agySplit is invoked
    Then it produces 1 history_message entry with role "assistant", record_type "PLANNER_RESPONSE" and content_text "I will inspect the files"
      And seq is 5, not the source line
      And cwd is null
      And it produces 1 history_tool_call entry with tool_name "view_file" and status "ok"
      And every pre-existing agySplit test passes without modification

  Scenario: R5 — history records satisfy the forensic contract
    Given a history.jsonl containing the four shapes above
    When runJsonlImport writes them to a fresh schema
    Then every history_message row inserts with non-null session_id, seq, role, record_type, disposition and provenance
      And no Zod validation error is reported

  Scenario: R6 — a second incremental import imports nothing
    Given a database with an unchanged history.jsonl already imported
    When runJsonlImport runs again in incremental mode on the same file
    Then processedLines equals the line count
      And importedRecords is 0
      And skippedDuplicates equals processedLines

  Scenario: R7 — a torn tail line does not abort the import
    Given a history.jsonl whose last line is a truncated JSON fragment
    When runJsonlImport runs for source "agy"
    Then the good records import
      And the corrupt line is skipped without a parse error

  Scenario: R10 — verification gate
    Given the working tree after implementation
    When bun run spur-check and bun run build run
    Then both exit 0 with no skipped tests and no new suppressions
```

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-08-31T15:51:07.890Z

**D1. `AGY_SCHEMA` / `AGY_FIELD_MAP` changes — dropped.** The earlier draft required adding
`display`/`conversationId`/`workspace` to both. Verified against the tree: `AGY_SCHEMA` is
`z.object({}).passthrough()` (accepts everything) and `AGY_FIELD_MAP` keys the **output** columns
consumed by `normalizeRecord`, which never sees `raw`. Adding raw input names there would be a
silent no-op that misleads the next reader. **Decision: no change to either symbol.**

**D2. Numeric millisecond timestamps — already handled.** `timestampOf` converts `> 1e12` numbers
via `new Date(ms).toISOString()` and `agySplit` already feeds it `raw.timestamp`.
**Decision: no change; keep the AC scenario as a regression lens only.**

**D3. Root widening vs. adding a second root.** Options were `['.gemini/antigravity-cli/brain',
'.gemini/antigravity-cli']` or the single widened root. `walkDir` recurses, so the pair is
redundant (the `found` Set dedupes, but the second root re-walks the whole subtree).
**Decision: single root `['.gemini/antigravity-cli']`.** Risk checked: the tree holds exactly one
`*.jsonl` outside `brain/` (`history.jsonl`), so nothing unwanted is admitted.

**D4. One `display` branch instead of per-`type` cases.** The earlier design enumerated
`slash_command` and empty-`type`; live data also contains `type: 'shell'`, and the producer can add
more. **Decision: discriminate on `raw.display !== undefined` and pass `raw.type` through as
`record_type`.** Verified safe: `display` appears 0 times in a 4,463-record legacy transcript
sample, while `type` + `step_index` appear on every legacy record.

**D5. The 89 records with no `conversationId` — deferred, not solved.** They are the first prompt
of each conversation, emitted before the id exists. Forward-filling requires cross-line state that
the per-record `agySplit` signature does not carry. **Decision: they land with
`session_id = 'unknown'`** — honest and consistent with every other mapper's fallback.
**Revisit when** a consumer needs per-conversation completeness for agy; the fix then is a
stateful pre-pass or joining `conversation_summaries.db`, and it belongs with the D6 task.

**D6. Conversation `.db` / `.pb` import — deferred to a separate task.** The task *title* names it;
the requirements never did. Splitting keeps this task to a ~40-line diff.
**Revisit when** step-level agy tool-call forensics are actually requested; model it on
`src/opencode-importer.ts`.

**D7. `seq` fallback.** History records have no `seq`/`step_index`, so all 977 would share `seq = 0`.
`source_line` is persisted, so ordering is technically recoverable — but every consumer sorts on
`seq`. **Decision: fall back to `context.sourceLine`**, matching `geminiSplit`. This does not
change legacy transcripts, which always supply `step_index`.

### Design

#### WHAT / WHY / WHERE

**WHAT** — two surgical edits: raise the `agy` discovery root one directory, and teach `agySplit`
one extra branch for `history.jsonl`-shaped records. No new file, no new export, no new dependency.

**WHY** — `history.jsonl` is the prompt index for every Antigravity CLI conversation, and it sits
one level above the configured root. The record shape (`display`/`workspace`/`conversationId`) has
no overlap with the legacy brain transcript shape (`content`/`type`/`step_index`), so a single
presence check separates them without a mode flag or a second source key.

**WHERE** — exactly two production files:

| File | Edit |
| --- | --- |
| `packages/llm-jsonl-importer/src/sources.ts:193-207` | `defaultRoots` value only |
| `packages/llm-jsonl-importer/src/mappers.ts:867-980` (`agySplit`) | 5 localized edits below |

#### Frozen shape — `src/sources.ts`

Change the third argument of the `customSourceDefinition('agy', …)` call from
`['.gemini/antigravity-cli/brain']` to `['.gemini/antigravity-cli']`. Everything else in the `agy`
entry — `filePatterns: ['*.jsonl']`, `agySplit`, `AGY_FIELD_MAP`, `AGY_SCHEMA`, the
`corruptLinePolicy: 'skip'` override and its task-0623 comment — is unchanged.

`discoverFiles` (`src/importer.ts:607-645`) resolves registry `defaultRoots` against `paths.home`
and hands each root to `walkDir` (`packages/runtime/src/fs.ts:64`), which recurses. The widened
root therefore *supersedes* the old one; adding a second root would only re-walk the same subtree.

#### Frozen shape — `agySplit` (`src/mappers.ts`)

Five edits, all inside the existing function. Names below are frozen; introduce no others.

1. **Session id (line 870)** — extend the alias list:

   ```ts
   const explicitSessionId = s(raw.session_id, raw.conversation_id, raw.conversationId);
   ```

2. **Seq fallback (line 872)** — replace the trailing `: 0` with the source line:

   ```ts
   const seq =
       typeof raw.seq === 'number'
           ? raw.seq
           : typeof raw.step_index === 'number'
             ? raw.step_index
             : (context?.sourceLine ?? 0);
   ```

3. **History branch** — declare `let messageRecordType = recordType;` next to `role` /
   `disposition` / `contentText`, then wrap the existing `switch (recordType) { … }` in an
   `else`:

   ```ts
   if (raw.display !== undefined) {
       // history.jsonl prompt index: {display, timestamp, workspace, conversationId?, type?}.
       // One branch covers absent type, 'slash_command', 'shell', and any future producer type.
       role = 'user';
       disposition = 'keep';
       contentText = s(raw.display) ?? null;
       messageRecordType = recordType.length > 0 ? recordType : 'USER_INPUT';
   } else {
       switch (recordType) {
           /* unchanged 0463 classification table, including the `default` arm */
       }
   }
   ```

4. **cwd (line 948)** — replace the hard-coded `cwd: null` with
   `cwd: s(raw.workspace, raw.cwd) ?? null`. Additive: legacy transcripts carry neither key and
   keep `null`.

5. **record_type (line 943)** — emit `record_type: messageRecordType` instead of `recordType`.

The `PLANNER_RESPONSE` tool-call block (lines 955-977) still keys off the raw `recordType` and is
left untouched — history records never carry `tool_calls`.

#### Precedence and invariants

- **Discrimination precedence:** `raw.display !== undefined` wins over `raw.type`. Verified safe —
  `display` occurs 0 times in a 4,463-record legacy transcript sample; every legacy record carries
  `type` **and** `step_index`.
- **Session precedence:** `session_id` → `conversation_id` → `conversationId` → brain-path UUID
  (`AGY_BRAIN_REGEX`) → `'unknown'`.
- **Timestamp:** unchanged. `timestampOf` (`mappers.ts:1619-1635`) already maps `1779224635930` →
  `'2026-05-19T21:03:55.930Z'` via the `> 1e12` millisecond branch.
- **Idempotence:** unchanged. `recordHash = sha256({source, sourceFile, sourceLine, splitIndex,
  record})` (`importer.ts:234-240`) is line-anchored and `history.jsonl` is append-only.
- **DDL:** `history_message` (`src/schema-sql.ts:29-54`) declares `record_type`/`disposition` as
  plain `TEXT NOT NULL` with no enum, so `'slash_command'` and `'shell'` insert cleanly.

#### Anti-patterns — do NOT implement

- Do **not** edit `AGY_SCHEMA` or `AGY_FIELD_MAP` (Q&A D1 — no-op at best, misleading at worst).
- Do **not** edit `timestampOf` (Q&A D2).
- Do **not** keep `.gemini/antigravity-cli/brain` as a second `defaultRoot` (Q&A D3).
- Do **not** write separate `case 'slash_command'` / `case 'shell'` arms (Q&A D4).
- Do **not** synthesize a session id for the 89 records lacking `conversationId`, and do not add a
  stateful forward-fill pass (Q&A D5).
- Do **not** create a new source key, a new module (`agy-history-importer.ts`), or a SQLite reader
  for `conversations/*.db` (Q&A D6).
- Do **not** change `corruptLinePolicy`, add a dependency, or touch a sibling package.
- Do **not** relax an existing `agySplit` test to make the new branch pass — legacy output must be
  byte-identical (R4).

#### Handoff

No `dependencies[]`; nothing is owed to or from another WBS. The deferred conversation-database
importer (Q&A D6) is a **new task**, not a continuation of this one, and must not be started here.

### Plan
1. [x] **`src/sources.ts`** — set `SOURCE_DEFINITIONS['agy']` `defaultRoots` to
   `['.gemini/antigravity-cli']`; leave `filePatterns`, the mapper wiring, and the
   `corruptLinePolicy: 'skip'` override untouched. → R1
2. [x] **`src/mappers.ts` — `agySplit`** — apply Design edits 1-5 in order (session alias, seq
   fallback, `display` branch + `messageRecordType`, `cwd`, `record_type`). Do not touch the
   `switch` body, `AGY_SCHEMA`, `AGY_FIELD_MAP`, or `timestampOf`. → R2, R3, R4, R5
3. [x] **`tests/forensic-contract.test.ts:203`** — update the `defaultRoots` assertion to
   `['.gemini/antigravity-cli']`. This test **will fail** until it is updated; that failure is
   expected, not a regression. → R1
4. [x] **`tests/mappers.test.ts`** — add the R2/R3 cases (bare `display`, `slash_command`, `shell`,
   missing `conversationId`) asserting role/disposition/record_type/content_text/cwd/seq/ts. Add
   the R4 legacy case asserting `seq = 5` and `cwd = null`. Leave existing `agySplit` tests
   byte-identical. → R2, R3, R4, R8
5. [x] **`tests/importer.test.ts`** — add a discovery test (in-memory FS with both
   `history.jsonl` and a brain transcript, imported via `roots`/`paths` rather than `files`) and
   the R6 double-import idempotence test. → R1, R6, R8
6. [x] **`README.md`** — extend the built-in-source line to say `agy` scans
   `~/.gemini/antigravity-cli` (both `history.jsonl` and `brain/**` transcripts) and that
   `conversations/*.db` stores are not imported. → R9
7. [x] **Verify** — `bun run spur-check` then `bun run build`; both exit 0. Fix root causes only;
   no `--no-verify`, no `.skip`, no `biome-ignore`. → R10
### Solution
Implemented by sp-super-coder (implement stage, sp-code-implementation competency) per frozen Design+Plan. Two production files + three test files + README.

- `packages/llm-jsonl-importer/src/sources.ts:197` — `agy.defaultRoots` → `['.gemini/antigravity-cli']` (R1).
- `src/mappers.ts` — `agySplit`: `conversationId` accepted as session id alias (R3); `seq` falls back to `context?.sourceLine ?? 0` like `geminiSplit` (R3); new history branch when `raw.display !== undefined` → `role='user'`, `disposition='keep'`, `content_text=display`, `messageRecordType = type || 'USER_INPUT'`, 0463 switch wrapped in `else` (R2); `cwd: s(raw.workspace, raw.cwd) ?? null` (R3); `record_type: messageRecordType` (R2). Switch body, `AGY_SCHEMA`, `AGY_FIELD_MAP`, `timestampOf`, tool-call blocks untouched — legacy brain-transcript output byte-identical (R4), proven by all pre-existing `agySplit` tests passing unmodified.
- `tests/mappers.test.ts` — five 0063 cases: bare display (cwd/ts/seq), `slash_command`, `shell`, missing `conversationId`, legacy `seq=5`/`cwd=null` + tool call.
- `tests/importer.test.ts` — discovery test (history.jsonl + brain transcript, both found, `cwd` persisted) + R6 idempotence lens (line-anchored-hash dedupe with `importedRecords=0`, `skippedDuplicates=processedLines`).
- `tests/forensic-contract.test.ts` — root assertion updated.
- `README.md` — scan scope documented; `conversations/*.db` stores explicitly not imported (R9).

Deviation: R6's gherkin says "incremental mode", but plain incremental short-circuits unchanged files at the checkpoint identity check (`src/importer.ts`) and can never report `processedLines = lineCount`; the regression lens uses `force-file`, which reads every line while keeping ledger dedupe — the exact line-anchored-hash behavior R6 protects. No production change needed, as the Design predicted. One pre-existing task-0678 fixture line in `tests/mappers.test.ts` received a semantics-preserving `?? {}` hardening (in-scope file; assertion outcome unchanged).
### Testing
**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/llm-jsonl-importer/src/sources.ts:197` — `defaultRoots` is exactly `['.gemini/antigravity-cli']` (brain suffix removed); `filePatterns: ['*.jsonl']` at `packages/llm-jsonl-importer/src/sources.ts:198`. Discovery lens `packages/llm-jsonl-importer/tests/importer.test.ts:585` (fake home holding `history.jsonl` + `brain/<uuid>/.system_generated/logs/transcript.jsonl` → scannedFiles=2, importedRecords=3, both source_files present). Root assertion `packages/llm-jsonl-importer/tests/forensic-contract.test.ts:203`. All re-read this run. |
| R2 | MET | `packages/llm-jsonl-importer/src/mappers.ts:889` — `raw.display !== undefined` branch sets role='user', disposition='keep', `content_text = s(raw.display)`, and `messageRecordType = recordType.length > 0 ? recordType : 'USER_INPUT'` at `packages/llm-jsonl-importer/src/mappers.ts:893`, which is exactly R2's `String(raw.type ?? '')` fallback given `recordType` at `packages/llm-jsonl-importer/src/mappers.ts:869`. Emitted at `packages/llm-jsonl-importer/src/mappers.ts:958`. Three producer shapes covered by one branch, proven at `packages/llm-jsonl-importer/tests/mappers.test.ts:945` (absent type), `:970` (slash_command), `:988` (shell). |
| R3 | MET | Session alias `s(raw.session_id, raw.conversation_id, raw.conversationId)` at `packages/llm-jsonl-importer/src/mappers.ts:870`; seq fallback to `context?.sourceLine ?? 0` at `packages/llm-jsonl-importer/src/mappers.ts:873-878`; `cwd: s(raw.workspace, raw.cwd) ?? null` at `packages/llm-jsonl-importer/src/mappers.ts:969`. Precedence brain-UUID then `'unknown'` via `sessionIdFromSourcePath` at `packages/llm-jsonl-importer/src/mappers.ts:871-872`. Lenses `packages/llm-jsonl-importer/tests/mappers.test.ts:1006` (unknown fallback) and `:945` (seq=7, cwd persisted) pass this run. |
| R4 | MET | 0463 switch body unchanged, wrapped in `else` at `packages/llm-jsonl-importer/src/mappers.ts:894`; tool-call block still keyed off raw `recordType` at `packages/llm-jsonl-importer/src/mappers.ts:973`. Legacy lens `packages/llm-jsonl-importer/tests/mappers.test.ts:1016` (seq=5, cwd=null, view_file tool call status ok) plus all pre-existing agySplit tests pass unmodified. Byte-identity strengthened from sample to full corpus this run: 84,898 records scanned across every brain jsonl shape (transcript, transcript_full, and the 873 `NNNNNNNN.jsonl` files not covered by the earlier sample) — 0 carry `display`, 0 carry `workspace`/`cwd`, 0 lack both `seq` and `step_index`, so no live legacy record can reach the new branch or shift `seq`/`cwd`. |
| R5 | MET | History rows emit non-null session_id/seq/role/record_type/disposition and `provenance: 'ambient'` at `packages/llm-jsonl-importer/src/mappers.ts:954-970`. End-to-end fresh-schema insert with `validationErrors` empty at `packages/llm-jsonl-importer/tests/importer.test.ts:634`. DDL `record_type`/`disposition` are plain `TEXT NOT NULL` with no enum at `packages/llm-jsonl-importer/src/schema-sql.ts:37-39`, so 'slash_command' and 'shell' insert cleanly. |
| R6 | MET | No production change needed, as the Design predicted — `recordHash = sha256({source, sourceFile, sourceLine, splitIndex, record})` at `packages/llm-jsonl-importer/src/importer.ts:234` is line-anchored and dedupe runs at `packages/llm-jsonl-importer/src/importer.ts:298`. Documented deviation (recorded in `### Solution`): plain `incremental` short-circuits an unchanged file on the (size, mtimeMs) identity check at `packages/llm-jsonl-importer/src/importer.ts:165-176` before any line is read, so `processedLines = lineCount` is unreachable there; the lens at `packages/llm-jsonl-importer/tests/importer.test.ts:653-679` uses `force-file`, which reads every line while keeping ledger dedupe, and asserts processedLines=2, importedRecords=0, skippedDuplicates=processedLines. Strictly stronger than the literal AC wording. Passes this run. |
| R7 | MET | `corruptLinePolicy: 'skip'` override intact with its 0623 rationale comment at `packages/llm-jsonl-importer/src/sources.ts:206`; the diff touched only `defaultRoots` in that block. Pre-existing torn-tail coverage `packages/llm-jsonl-importer/tests/importer.test.ts:1016` passes this run. |
| R8 | MET | Four history shapes + cwd + numeric-epoch ts (1779224635930 to '2026-05-19T21:03:55.930Z') + seq-from-sourceLine at `packages/llm-jsonl-importer/tests/mappers.test.ts:945`, `:970`, `:988`, `:1006`, `:1016`; discovery and idempotence lenses at `packages/llm-jsonl-importer/tests/importer.test.ts:585` and `:653`; root assertion updated at `packages/llm-jsonl-importer/tests/forensic-contract.test.ts:203`. Targeted run this turn: `bun test tests/mappers.test.ts tests/importer.test.ts tests/forensic-contract.test.ts` — 219 pass, 0 fail, 990 expect() calls. |
| R9 | MET | `packages/llm-jsonl-importer/README.md:22` states the `agy` source scans `~/.gemini/antigravity-cli`, covering both `history.jsonl` and `brain/**` transcripts, and that conversation `.db` stores under `conversations/` are not imported. Re-read this run. |
| R10 | MET | Fresh this run: `bun run spur-check` exit 0 — Biome + per-package typecheck + 2066 pass / 0 fail across 178 files, and both spur rule presets green (coverage-gate, every-export-has-tsdoc). `bun run build` exit 0 for all 8 packages. No `.skip`/`.todo` and no new `biome-ignore` in the diff. Coverage: measured by the `coverage-gate` spur rule inside `bun run spur-check` — passed. Gitignored fix-pass writes this run (disclosure): `.spur/run/0063-verify-answer.txt` fully rewritten (45 lines; repo-relative citation repair + untruncated R2 evidence) and `.spur/run/0063-verdict.json` regenerated from it via `spur task verdict --from-answer` (10 requirements, 10 acceptanceCriteria, 2 checks); no other `.spur/run` artifact touched. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| Scenario: R1 — the widened root discovers history.jsonl and brain transcripts together | MET | test | `packages/llm-jsonl-importer/tests/importer.test.ts:585` — scannedFiles=2, importedRecords=3, brain transcript row present; `packages/llm-jsonl-importer/tests/forensic-contract.test.ts:203` asserts the defaultRoots value |
| Scenario: R2 — a bare display record maps to a kept user prompt | MET | test | `packages/llm-jsonl-importer/tests/mappers.test.ts:945` — session_id, role=user, disposition=keep, record_type=USER_INPUT, content_text, cwd=/Users/robin/xprojects/spur, seq=7, ts='2026-05-19T21:03:55.930Z', provenance=ambient, 0 tool calls |
| Scenario: R2 — a slash_command record keeps its producer type as record_type | MET | test | `packages/llm-jsonl-importer/tests/mappers.test.ts:970` — record_type='slash_command', role=user, disposition=keep |
| Scenario: R2 — a shell record is classified by the same branch, not a special case | MET | test | `packages/llm-jsonl-importer/tests/mappers.test.ts:988` — record_type='shell' via the same display branch; no dedicated case arm exists in `packages/llm-jsonl-importer/src/mappers.ts:889-893` |
| Scenario: R3 — a display record without conversationId falls back to unknown | MET | test | `packages/llm-jsonl-importer/tests/mappers.test.ts:1006` — session_id='unknown', role=user, disposition=keep |
| Scenario: R4 — legacy transcript records are unchanged | MET | test | `packages/llm-jsonl-importer/tests/mappers.test.ts:1016` — role=assistant, record_type=PLANNER_RESPONSE, seq=5 (not sourceLine), cwd=null, 1 view_file tool call status ok; all pre-existing agySplit tests pass unmodified |
| Scenario: R5 — history records satisfy the forensic contract | MET | test | `packages/llm-jsonl-importer/tests/importer.test.ts:634` — fresh-schema insert of all shapes, validationErrors empty, non-null contract columns |
| Scenario: R6 — a second incremental import imports nothing | MET | test | `packages/llm-jsonl-importer/tests/importer.test.ts:653-679` — documented deviation: `force-file` replaces `incremental` because the (size, mtimeMs) short-circuit at `packages/llm-jsonl-importer/src/importer.ts:165-176` makes the literal wording unreachable; asserts importedRecords=0 and skippedDuplicates=processedLines=2 |
| Scenario: R7 — a torn tail line does not abort the import | MET | test | `packages/llm-jsonl-importer/tests/importer.test.ts:1016` — agy 'skip' policy drops corrupt lines without parse errors and still imports good records |
| Scenario: R10 — verification gate | MET | command | `bun run spur-check` exit 0 (2066 pass / 0 fail, both rule presets green) and `bun run build` exit 0, both run this turn |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)
### Review

| Priority | Dimension | Location | Finding |
| --- | --- | --- | --- |
| P4 | correctness | `packages/llm-jsonl-importer/src/mappers.ts:873-878` | Seq fallback is unconditional: a legacy-shaped record carrying neither `seq` nor `step_index` now gets `context.sourceLine` where the pre-change mapper emitted `0`. Real brain transcripts always carry `step_index` (4,463-record sample), so R4 byte-identity holds on live data; edit is design-frozen (Design edit 2). No action. |
| P4 | scope | `packages/llm-jsonl-importer/tests/mappers.test.ts:1675` | Disclosed semantics-preserving `?? {}` hardening on a task-0678 fixture line: green path identical; red path now fails via expectation instead of TypeError. In-scope file, assertion outcome unchanged. No action. |
| P4 | architecture | `packages/llm-jsonl-importer/src/mappers.ts:867-995` | `agySplit` (~130 lines) now maps two record families. Acceptable at current size; if the deferred conversation-`.db` importer (Q&A D6) lands, split shape classification from row emission. Advisory. |

Deviation audits (all assessed, none blocking):

- **R6 force-file lens** — verified necessary. `incremental` short-circuits unchanged files at the (size, mtimeMs) identity check (`src/importer.ts:165-176`) before any line is read, so `processedLines = lineCount` is unreachable there; `force-file` skips checkpoints (`src/importer.ts:165`), reads every line, and keeps ledger dedupe (`src/importer.ts:299`) over the line-anchored `recordHash` (`src/importer.ts:236-243`). Lens asserts `processedLines=2, importedRecords=0, skippedDuplicates=processedLines` (`tests/importer.test.ts:653-661`). Documented in Solution → CHANGED, PASS-acceptable.
- **R2 contract** — `messageRecordType = recordType.length > 0 ? recordType : 'USER_INPUT'` (`src/mappers.ts:893`, with `recordType = String(raw.type ?? '')` at `:869`) is exactly R2's `String(raw.type ?? '') || 'USER_INPUT'`; any future non-empty producer type passes through as `record_type` (slash_command and shell proven by tests).
- **Anti-patterns held** — `AGY_SCHEMA`, `AGY_FIELD_MAP`, `timestampOf` untouched; single widened root (no brain re-add); no `.skip`/`.todo`/new `biome-ignore` in the diff; no dependency added.

| Req | Status | Evidence |
| --- | --- | --- |
| R1 | MET | `src/sources.ts:197` — `['.gemini/antigravity-cli']`, `filePatterns` unchanged `:198`; discovery test `tests/importer.test.ts:585-637` (scannedFiles=2, importedRecords=3, brain transcript row present); `tests/forensic-contract.test.ts:203` updated |
| R2 | MET | `src/mappers.ts:889-893` — display branch (user/keep/display→content_text); tests `tests/mappers.test.ts:938-1002` (bare `USER_INPUT`, `slash_command`, `shell` passthrough) |
| R3 | MET | `src/mappers.ts:870` session alias incl. `conversationId`; `:873-878` seq→sourceLine fallback; `:969` `cwd: s(raw.workspace, raw.cwd) ?? null`; brain-UUID precedence `:871,1089-1103`; unknown fallback test `tests/mappers.test.ts:1004-1011` |
| R4 | MET | 0463 switch body byte-identical inside `else` (`src/mappers.ts:894-948`); `messageRecordType` init `:884`, legacy-identity emit `:958`; existing agySplit tests unmodified (only additive describe `:934-1044`); legacy lens `tests/mappers.test.ts:1013-1040` (seq=5, cwd null, `view_file` tool call status ok) |
| R5 | MET | history rows non-null session/seq/role/record_type/disposition + `provenance: 'ambient'` (`src/mappers.ts:955-970`); end-to-end fresh-schema insert with empty `validationErrors` (`tests/importer.test.ts:613-631`) |
| R6 | MET | via verified deviation — force-file lens `tests/importer.test.ts:653-661`; rationale proven at `src/importer.ts:165-176,236-243,299` (see deviation audit) |
| R7 | MET | `corruptLinePolicy: 'skip'` override intact `src/sources.ts:203-207`; pre-existing torn-tail coverage `tests/importer.test.ts:1015-1035` (task 0623) |
| R8 | MET | four history shapes + cwd + epoch ts + seq-from-sourceLine `tests/mappers.test.ts:937-1040`; discovery + R6 lenses `tests/importer.test.ts:585-661`; root assertion `tests/forensic-contract.test.ts:203` |
| R9 | MET | `README.md:22` — scans `~/.gemini/antigravity-cli` covering `history.jsonl` + `brain/**`; "conversation `.db` stores under `conversations/` are not imported" |
| R10 | MET | fresh this review: `bun run spur-check` exit 0 (biome 405 files clean, 2066 pass / 0 fail, both rule presets green), `bun run build` exit 0; no new suppressions |

Residual risk: synthetic legacy records lacking both `seq` and `step_index` order by source line instead of collapsing to 0 (improvement; design-frozen); the 89 first-prompt records land as `session_id='unknown'` by design (Q&A D5); conversation `.db`/`.pb` import remains deferred to a separate task (Q&A D6).

Review verdict: APPROVED

### References

- Feature: [E (ts-llm-jsonl-importer)](file:///Users/robin/xprojects/ts-libs/docs/features/E_ts-llm-jsonl-importer.md)
- Prior Idea Evaluation: [`.spur/run/1A9E3E71-8C06-4397-81C8-40D7CE31FD48-idea-eval-report.md`](file:///Users/robin/xprojects/ts-libs/.spur/run/1A9E3E71-8C06-4397-81C8-40D7CE31FD48-idea-eval-report.md)
- Importer Source Definitions: [`packages/llm-jsonl-importer/src/sources.ts`](file:///Users/robin/xprojects/ts-libs/packages/llm-jsonl-importer/src/sources.ts)
- Importer Mappers: [`packages/llm-jsonl-importer/src/mappers.ts`](file:///Users/robin/xprojects/ts-libs/packages/llm-jsonl-importer/src/mappers.ts)
- OpenCode SQLite Importer Pattern: [`packages/llm-jsonl-importer/src/opencode-importer.ts`](file:///Users/robin/xprojects/ts-libs/packages/llm-jsonl-importer/src/opencode-importer.ts)
- Medium Reference: [Antigravity CLI Tutorial Series — Part 2: Conversations](https://medium.com/google-cloud/antigravity-cli-tutorial-series-part-2-conversations-conversations-and-conversations-76f61756d5bb)

### History

- 2026-08-31T16:42:31.624Z todo → wip (system)
- 2026-08-31T17:02:03.583Z wip → testing (system)
- 2026-08-31T17:02:47.759Z testing → done (system)
