---
schema_version: 1
name: Resolve package contract and documentation conflicts C01-C08
status: done
template: standard
created_at: 2026-09-16T16:43:29.624Z
updated_at: "2026-09-16T20:54:25.753Z"
feature_id: E

priority: P1
ac_altitude: task-local
ac_numbering: task-local
---

## 0068. Resolve package contract and documentation conflicts C01-C08

### Background

Capture findings C01–C08 from the 2026-09-16 inline, cold conflict audit of packages for a later repair pass. The user requested a detailed task file, not immediate implementation. No audit finding is fixed by creating this record.

Baseline commit: `3d1d074d4d5bd01531c4b16442cf6c78618313db`. All 33 original evidence anchors were revalidated by whole-file SHA-256 before this task was authored; all matched. The evidence and reproduction steps below are self-contained: the original temporary audit report/JSON are not required to execute this task. Line numbers are baseline locators, not immutable identifiers; use the named symbols/headings and re-read changed files.

Primary feature: E (importer maintenance), because the two governing contract conflicts and most affected usage documentation concern the importer. This is explicitly cross-package maintenance: C04 belongs to runtime, C05 to rule-engine, C03 to feature projections, and C08 to shared documentation. The E link is administrative ownership; it neither narrows the task to importer-only edits nor enlarges E's product scope. Scenarios are task-local maintenance AC, not new feature shipping criteria. Related feature I owns the DeepSeek AC in C01; its lifecycle is unchanged by this task.

Audit baseline: eight evidence-backed findings (two high, four medium, two low). Package verification passed: 2,250 tests / zero failures, 49 pre-check rules, two post-check rules, all eight typechecks and builds. Feature validation passed 12/12. Separately, the current task validator rejected 43/66 historical task records. Those counts are historical audit evidence, not a fresh completion verdict for this task; later counts may legitimately increase.

The known task-corpus failures (U01) are excluded. A migration dry run proposed 22 changes and skipped 0012/0013 because required name metadata was absent; it would not repair the corpus completely. Do not normalize historical records, invent review evidence, or bypass gates to make this task appear green.

Completion means C01–C08 each has a documented, verified disposition and no conflicting current claim remains within its bounded repair surfaces. Planned recommendations for C01/C02 remain pending until the repair direction is explicitly authorized in the execution session or recorded decision evidence; this capture is not approval to change an ADR or feature contract.

### Requirements

- [x] R1. C01 — Resolve the DeepSeek header conflict across feature I Scope/AC, task 0067 Requirements/AC/Design/Q&A and its current verification interpretation, CHANGELOG and the dshSplit docblock. Record the chosen behavior explicitly. Recommended outcome preserves one metadata row per imported session header (role=meta, disposition=meta), plus the user/assistant rows; the three-record fixture remains three imported records. Do not describe that as skipping the header or invent a change to importedRecords counting.
- [x] R2. C02 — Resolve the accepted ADR-023 eager-ETL promise against lazy materialization. Recommended outcome preserves lazy creation and first appends a dated amendment that supersedes only the 2026-08-12 eager guarantee; then add a dated supersession note to historical task 0061. Do not silently treat source or passing tests as an ADR amendment, or rewrite the task's historical acceptance evidence.
- [x] R3. C03 — Regenerate E and I task rosters from current task frontmatter through scoped spur feature refresh. Include every currently linked task (including this task if still linked to E), with actual statuses; 0064 must no longer be missing and 0066/0067 must reflect their current done state if unchanged. Add feature I to docs/05_FEATURES.md using its actual current lifecycle status and satellite pointer. Do not infer feature done from child completion.
- [x] R4. C04 — Runtime README must say the legacy filesystem APIs/classes were removed by ADR-019, not merely deprecated. Replace the removed NodeFileSystem setup annotation with the canonical FileSystem contract. Keep valid deprecated context/process APIs untouched; do not restore removed exports.
- [x] R5. C05 — Rule-engine README must describe ExtensionRef as kind + authored relative path + absolute baseDir + sourceName, matching the current interface and trust validation order. Do not reintroduce absPath/presetName or change the loader to accept absolute authored paths.
- [x] R6. C06 — Importer README must distinguish uncompressed streaming line reads from whole-file zstd decompression and the non-streaming readFile fallback. Bound the O(line) claim to line reading; do not promise end-to-end O(line) memory without examining discovery/checkpoint/batch state. Preserve the explicitly accepted buffered implementation.
- [x] R7. C07 — Importer README's built-in source-key roster must match the current SOURCE_DEFINITIONS keys, including deepseek. Preserve agy versus antigravity identity and existing source names; do not change registry/runtime behavior to fit prose.
- [x] R8. C08 — Qualify ADR-112, A21 and task 0734 as Spur-owned in the targeted architecture and importer documentation, including the second A21 deadline paragraph in the architecture document. Verify actual upstream paths/anchors before adding links. Do not invent local records or imply external decisions automatically supersede local ADRs.
- [x] R9. Revalidate the evidence and explicit authorization before each repair group. Distinguish already-fixed, still-valid and stale findings. If current code or authority materially changes the proposed direction, update the evidence and decision record before dependent edits; no mechanical application of baseline line numbers or historical hashes. Use owner surfaces: spur task/feature for corpus writes, scoped feature refresh for generated regions, and sp-doc-evolve for numbered documents. Apply authority decisions before projections, update substantive numbered-doc frontmatter version/date, and preserve ADR numbers/history and unrelated corpus evidence.
- [x] R10. Verify each finding with the targeted commands and expected outcomes in Design, run fresh bun run spur-check and bun run build once the final patch is ready, validate this task and affected E/I features, and review git status/diff for only authorized changes. Record current evidence for C01–C08 separately; historical green runs do not prove the repair. Keep the repair bounded to C01–C08 and the documented file/section allowlist. No U01 bulk task migration, dependency/export/API/schema changes, streaming refactor, new test framework, new runtime, release/publish/commit/push, .github/workflows changes, automatic feature closure, or sibling-repository mutation. New tests are needed only if a material behavior gap is discovered and its implementation scope is separately authorized; never weaken existing tests to reconcile prose.

### Acceptance Criteria

```gherkin
Feature: Resolve package contract and documentation conflicts C01-C08

  @core
  Scenario: R1 — DeepSeek header contract matches its approved behavior
    Given the baseline feature/task header-skip claims and the metadata-producing dshSplit implementation
    When the approved C01 repair is applied and the existing DeepSeek fixture is checked
    Then all current claims agree on whether a metadata row is persisted, and the retained-behavior option yields one meta row plus two conversational rows without changing importedRecords semantics

  @core
  Scenario: R2 — ETL creation authority is reconciled before projections
    Given ADR-023 promises eager creation and the current schema helper intentionally creates no generic ETL tables
    When the approved C02 decision and dated supersession note are recorded
    Then the current authority states the chosen contract explicitly, the original ADR/task history remains readable, and the recommended lazy option leaves zero history_etl_* tables after schema-only setup

  @core
  Scenario: R3 — Feature rosters and numbered summary reflect current corpus
    Given tasks 0064, 0066 and 0067 have authoritative frontmatter and this repair task is linked to E
    When the two scoped feature refresh commands and numbered-summary update finish
    Then E and I rosters match every linked task and status, I has one summary row with its real lifecycle status, and no feature lifecycle was advanced implicitly

  @core
  Scenario: R4 — Runtime documentation no longer advertises removed filesystem APIs
    Given ADR-019 and the current runtime index define the removed and canonical filesystem surfaces
    When the runtime README repair is reviewed
    Then getFs/setFileSystem/SyncFileSystem and removed classes are described as removed, the setup uses the FileSystem contract, and no old export is restored

  @core
  Scenario: R5 — ExtensionRef usage documents the authored-path contract
    Given the exported interface defines kind, path, baseDir and sourceName
    When the rule-engine README entity row is compared with the interface
    Then it describes a relative authored path and absolute declaring directory and does not require an absolute authored module path

  @core
  Scenario: R6 — Streaming documentation exposes both buffering exceptions
    Given readLines branches on compressed files before consulting readFileStream
    When the Streaming paragraph is compared with all three read paths
    Then uncompressed line streaming is distinguished from decompressed-file buffering and readFile fallback without a new streaming implementation or an unqualified end-to-end O(line) claim

  @core
  Scenario: R7 — Built-in source roster is complete
    Given the live SOURCE_DEFINITIONS registry includes deepseek
    When its key set is compared with the README built-in roster
    Then all current keys appear exactly once in the roster and no registry key or alias was changed

  @core
  Scenario: R8 — Cross-repository authority provenance is explicit
    Given ADR-112, A21 and 0734 resolve to Spur records rather than local ts-libs records
    When the targeted architecture and importer reference occurrences are read
    Then each names Spur as owner and any new link resolves to a verified record without introducing local placeholder records or sibling edits

  @core
  Scenario: R9 — Fresh evidence and owner routing preserve authority and history
    Given baseline fingerprints, current evidence and the decision and ownership rules in Requirements
    When each repair group is prepared and applied
    Then changed anchors are re-read and the execution session records the chosen C01/C02 directions before dependent edits
    And already-fixed findings require no write, corpus mutations use Spur, authority precedes projections, and historical decisions remain readable

  @core
  Scenario: R10 — Fresh verification and the bounded diff establish completion
    Given the C01-C08 file and section allowlist and explicit exclusions
    When the focused checks, full project gates, affected corpus checks and final diff review finish
    Then every finding has current evidence and the project checks and build pass without suppression
    And every change maps to this task while baseline corpus debt, runtime redesign, publication, workflow edits and implicit feature closure remain excluded
```

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-09-16T17:32:37.131Z

**Execution-session decision (authorization basis).** The `/sp-dev-run 0068 --mode implement --auto` session authorizes the task's stated recommended directions for C01 and C02; the plan's "recommendations are not accepted decisions" caveat is discharged here, before any dependent edit, by recording the choices explicitly.

- **C01 — DeepSeek session header: retain the metadata row (recommended option).** Shipped behavior is authoritative for the record shape: `dshSplit` persists one `history_message` row with `role=meta`, `record_type=session`, `disposition=meta` carrying session id, `cwd` and `createdAt`, and emits `keep` rows for `user/message` and `assistant/message`; the fixture's three imported records stay three. The literal "header line is skipped" wording in feature I Scope/AC and task 0067 R2/AC/Design is superseded by the amended feature AC; `importedRecords` counting is unchanged. The literal-removal alternative (dropping the header row and losing `cwd`/creation-time provenance) was **not** selected — it is a behavior change requiring its own scope.
- **C02 — Importer ETL materialization: keep lazy creation (recommended option).** `applyHistoryImportSchema` installs static contract/bookkeeping tables only; generic `history_etl_*` tables are materialized on the first accepted write. A dated ADR-023 amendment supersedes only the 2026-08-12 eager-materialization guarantee (R16), and task 0061 gets a dated supersession note preserving its historical acceptance record. The source-reverting/eager alternative was **not** selected — it is a behavior change requiring its own scope and decision.

Both choices are documentation/authority reconciliations: no source logic, schema, export, or dependency changes follow from them.

### Design

#### Authority and execution order

Process is owned by docs/99_PROJECT_CONSTITUTION.md; architecture by accepted local ADR entries; scope by docs/01_PRD.md; feature AC by the feature satellite within those constraints; task obligations by Requirements/AC. Source/tests establish observed behavior. The audit compares claims, not merely wording. Superseded ADR-008 and ADR-017 are historical.

Record the C01/C02 decision before editing their normative text. Recommended plan preserves the shipped behavior, but recommendations are not accepted decisions. Apply a dated ADR amendment before derived corrections; update feature AC before aligning task wording; preserve historical task verdicts with dated clarification. C03 generated rosters are repaired after relevant corpus changes. C04–C08 are bounded factual documentation corrections. No automatic approval pause is needed when an execution session already contains explicit authorization for the chosen direction; cite it instead of asking twice.

#### Finding-to-requirement map

| Finding | Priority | Requirement | Subject |
| --- | --- | --- | --- |
| C01 | high / high confidence | R1 | DeepSeek session-header contract |
| C02 | high / high confidence | R2 | Eager versus lazy importer ETL materialization |
| C03 | medium / high confidence | R3 | Feature projections lag the task graph |
| C04 | medium / high confidence | R4 | Removed runtime filesystem exports described as deprecated |
| C05 | medium / high confidence | R5 | Rule-engine ExtensionRef description uses the retired absolute-path shape |
| C06 | medium / high confidence | R6 | Importer streaming memory guarantee omits compressed-file buffering |
| C07 | low / high confidence | R7 | Importer built-in source roster omits deepseek |
| C08 | low / high confidence | R8 | External authority references are not repository-qualified |

#### C01 — DeepSeek session-header contract

**Classification:** contradiction; high; high confidence. **Baseline status:** open, not repaired.

**Normative claim:** Feature I / R5 and task 0067 / R2 explicitly require skipping the header.

**Observed reality:** dshSplit persists a history_message row with role=meta and disposition=meta; the regression test expects three records for header + two messages. The task Solution/Testing describes that behavior while marking the skip requirement MET.

**Authority resolution:** Feature AC governs task obligations within PRD/ADR bounds; passing tests and a task verdict cannot silently rewrite an AC.

**False-positive challenge:** Not planned work: task 0067 is done. The Solution documents an intentional implementation choice, but neither the feature nor its AC was amended. This is not merely message-vs-metadata wording: the AC says the header line is skipped.

**Evidence anchors:**

| File:line | Stable search anchor / opposing claim |
| --- | --- |
| `docs/features/I_add-deepseek-dsh-coding-agent-support.md:73` | Then the header line is skipped |
| `docs/tasks/0067_add-deepseek-session-source-to-ts-llm-jsonl-importer.md:28` | R2 (feature I/R5) |
| `packages/llm-jsonl-importer/src/mappers.ts:1466` | if (recordType === 'session') |
| `packages/llm-jsonl-importer/tests/deepseek-importer.test.ts:126` | expect(result.importedRecords).toBe(3) |
| `CHANGELOG.md:34` | streams skip the per-session header |

**Permitted repair surfaces:** docs/features/I_add-deepseek-dsh-coding-agent-support.md (Scope, Acceptance Criteria); docs/tasks/0067_add-deepseek-session-source-to-ts-llm-jsonl-importer.md (Requirements, Acceptance Criteria, Design and appended decision/clarification); CHANGELOG.md (DeepSeek header claim only); packages/llm-jsonl-importer/src/mappers.ts (dshSplit documentation only under recommended outcome). README already states the current meta behavior and is evidence, not a reason for unrelated rewriting.

**Repair detail and anti-drift constraints:**

The contradiction occurs within the task itself: R2 and scenario R5 say the header is skipped; Solution and Testing describe a metadata row and label the requirement MET. An existing PASS receipt is not proof the original wording was met. Preserve the receipt as history and append the correction; do not fabricate a new historical PASS. The feature Scope also contains a header-skip line and a test-scope phrase about header handling. The mapper docblock says only chat events become history_message rows, immediately above a session branch that returns a row to that table; align that docblock too. The metadata row carries session_id, seq=0, role=meta, record_type=session, disposition=meta, ts from createdAt and cwd, with content_text=null. Chat rows remain disposition=keep. importedRecords counts persisted metadata too; the current fixture expects 3, not 2. No new consumer-side filtering or statistics work is authorized.

Recommended new claim: “The session header is retained as one history_message metadata row carrying session identity, cwd and creation time; user/message and assistant/message become conversational rows. Unrecognized event types remain skipped.” If literal header removal is chosen instead, assess the lost cwd/time provenance and all dshSplit callers first, obtain that behavior-change scope, and revise this plan/AC before implementing it.

**Owner route:** spur feature / spur task for corpus; source build competency for docblock; document maintenance for CHANGELOG. Use the live CLI's section list/show to resolve addressable sections before writes. Package README edits are ordinary scoped documentation maintenance; numbered-doc changes use sp-doc-evolve.

**Reproduction / focused verification (from repository root):**

```sh
rg -n 'header|meta|skipped' docs/features/I_add-deepseek-dsh-coding-agent-support.md docs/tasks/0067_add-deepseek-session-source-to-ts-llm-jsonl-importer.md packages/llm-jsonl-importer/README.md
rg -n 'Session header|recordType ===|role:|disposition:' packages/llm-jsonl-importer/src/mappers.ts
bun test packages/llm-jsonl-importer/tests/deepseek-importer.test.ts packages/llm-jsonl-importer/tests/zstd.test.ts
```

**Expected verification:** Existing raw/compressed equality, metadata-row assertion, message identities, torn-tail handling and missing-zstd behavior remain green. Review every header occurrence in the scoped documents; historical excerpts may remain only when clearly labeled as superseded.

**Original evidence fingerprint:** `0d46f814c753a626244cb4063bc2a1a0c419ff0b9fd4f0e43709986585c74520`. Fingerprint identifies the original finding; it is not proof the file remains unchanged after repair.

#### C02 — Eager versus lazy importer ETL materialization

**Classification:** contradiction; high; high confidence. **Baseline status:** open, not repaired.

**Normative claim:** Accepted ADR-023 addendum states every built-in ETL table is created through ensureTargetTables looping SOURCE_DEFINITIONS. Task 0061 R2 explicitly requires applyHistoryImportSchema to materialize every built-in table.

**Observed reality:** applyHistoryImportSchema creates only static tables; generic ETL tables are lazy. A live in-memory database had zero history_etl_* tables after schema application. The regression test explicitly requires zero.

**Authority resolution:** Constitution §2 / §6.1: an accepted local ADR is normative; a behavior change requires a dated amendment. Source describes what happens, not automatic decision authority.

**False-positive challenge:** Commit 22f891f intentionally introduced lazy materialization on 2026-08-21, so the old task is historical rather than an unfinished implementation. The still-accepted ADR lacks the superseding amendment.

**Evidence anchors:**

| File:line | Stable search anchor / opposing claim |
| --- | --- |
| `docs/00_ADR.md:355` | ETL_TABLE_DDL` / `ensureTargetTables` looping |
| `docs/tasks/0061_fix-packages-review-session-bottlenecks-skill-path-drift-dua.md:39` | must still create **all** built-in ETL tables |
| `packages/llm-jsonl-importer/src/jsonl-importer-dao.ts:134` | export async function applyHistoryImportSchema |
| `packages/llm-jsonl-importer/tests/jsonl-importer-dao.test.ts:316` | creates typed tables but no empty built-in |

**Permitted repair surfaces:** docs/00_ADR.md (dated ADR-023 amendment + frontmatter); docs/tasks/0061_fix-packages-review-session-bottlenecks-skill-path-drift-dua.md (resolve real filename with spur task show 0061; dated note in an addressable owner section). Source/tests and current importer README remain evidence unless current review identifies another conflicting sentence.

**Repair detail and anti-drift constraints:**

Commit 22f891f8b88eca7b323a8e02bfc5a1cd354afc79 intentionally removed the SOURCE_DEFINITIONS loop from applyHistoryImportSchema on 2026-08-21 and updated tests/README. The 2026-08-12 ADR-023 addendum was not amended. Task 0061 was true historically, so do not erase or uncheck its original completion record; explain that its eager guarantee was superseded later. The history entry in CHANGELOG describing the older release is historical, unlike C01's incorrect account of what the DeepSeek release shipped.

Recommended amendment text: “Generic history_etl_* tables are materialized on the first accepted write. applyHistoryImportSchema installs static contract and bookkeeping tables only. This supersedes the eager-materialization guarantee in the 2026-08-12 ADR-023 addendum and avoids unused empty tables.” Link mechanism/usage to the current importer README; keep amendment rationale short. Date it when the decision is actually accepted; do not backdate authorization. A source-reverting/eager alternative requires explicit decision and implementation scope; it is not the default repair.

**Owner route:** sp-doc-evolve first; spur task update 0061 after authority amendment. Use the live CLI's section list/show to resolve addressable sections before writes. Package README edits are ordinary scoped documentation maintenance; numbered-doc changes use sp-doc-evolve.

**Reproduction / focused verification (from repository root):**

```sh
git show --stat 22f891f8b88eca7b323a8e02bfc5a1cd354afc79
rg -n 'ETL_TABLE_DDL|ensureTargetTables|SOURCE_DEFINITIONS' docs/00_ADR.md
spur task show 0061 --json
bun test packages/llm-jsonl-importer/tests/jsonl-importer-dao.test.ts --test-name-pattern 'lazy ETL materialization'
bun test packages/llm-jsonl-importer/tests/schema-sql.test.ts
```

**Expected verification:** On a fresh :memory: adapter, applyHistoryImportSchema creates static tables and SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'history_etl_%' returns []. Existing lazy-first-accepted-record behavior is preserved. ADR and dated historical-task note agree.

**Original evidence fingerprint:** `4db0a4186f0f9606e8179ee32d801d160bc6d5735ff268cd0d06e528b8194898`. Fingerprint identifies the original finding; it is not proof the file remains unchanged after repair.

#### C03 — Feature projections lag the task graph

**Classification:** stale; medium; high confidence. **Baseline status:** open, not repaired.

**Normative claim:** Task frontmatter owns task state; constitution §4.5/§6.6 requires refreshed feature rosters and index pointers.

**Observed reality:** E omits linked done task 0064. I lists 0066 as testing and 0067 as todo although both are done. docs/05_FEATURES.md omits I entirely while INDEX.md contains it.

**Authority resolution:** The task graph is authoritative for generated task rows; feature frontmatter is authoritative for feature state. Refresh does not close a feature.

**False-positive challenge:** Package-parent backlog states are organizational containers and were not treated as unimplemented libraries. I remains active until its AC mismatch is resolved; no done status is inferred from child completion.

**Evidence anchors:**

| File:line | Stable search anchor / opposing claim |
| --- | --- |
| `docs/features/E_ts-llm-jsonl-importer.md:25` | ## Tasks |
| `docs/tasks/0064_retain-forensic-tool-call-metadata-in-ts-llm-jsonl-importer-.md:8` | feature_id: E |
| `docs/features/I_add-deepseek-dsh-coding-agent-support.md:105` | \| 0066 \| |
| `docs/tasks/0066_add-deepseek-dsh-shim-to-ts-ai-runner.md:4` | status: done |
| `docs/tasks/0067_add-deepseek-session-source-to-ts-llm-jsonl-importer.md:4` | status: done |
| `docs/05_FEATURES.md:20` | ## Feature summary |
| `docs/features/INDEX.md:15` | **I** |

**Permitted repair surfaces:** docs/features/E_ts-llm-jsonl-importer.md and docs/features/I_add-deepseek-dsh-coding-agent-support.md (generated Tasks regions); docs/features/INDEX.md (generated index); docs/05_FEATURES.md (manually maintained summary row + frontmatter).

**Repair detail and anti-drift constraints:**

Baseline E contains 0063 only although 0064 is feature_id E and done. Baseline I says 0066 testing and 0067 todo although their task frontmatter says done. I is already in docs/features/INDEX.md with active status, but missing from docs/05_FEATURES.md. This task introduces another legitimate E edge, so the expected E roster must be recomputed rather than hard-coded to only 0063/0064.

Use separate “spur feature refresh --feature E --json” and “spur feature refresh --feature I --json”. The commands regenerate INDEX.md but do not change feature frontmatter. They do not maintain the custom numbered summary; update that summary through sp-doc-evolve after reading the refreshed satellites. Preserve active status unless an independently authorized lifecycle action has already changed it; do not run feature sync just because children are done. Parent package backlog statuses are containers and are not evidence of unimplemented packages.

**Owner route:** spur feature refresh; sp-doc-evolve. Use the live CLI's section list/show to resolve addressable sections before writes. Package README edits are ordinary scoped documentation maintenance; numbered-doc changes use sp-doc-evolve.

**Reproduction / focused verification (from repository root):**

```sh
spur task list --feature E --json
spur task list --feature I --json
spur feature show E --json
spur feature show I --json
rg -n '^\| (E|I) \|' docs/05_FEATURES.md
spur feature check E --json
spur feature check I --json
```

**Expected verification:** Every linked task has exactly one generated row with the current name/status; I has one numbered summary entry pointing to the correct satellite. Feature statuses remain unchanged by refresh.

**Original evidence fingerprint:** `59f6ab92e6922e1cb79c28cb2f856175e9f6f23d41dcfea4bceb18c1658f8887`. Fingerprint identifies the original finding; it is not proof the file remains unchanged after repair.

#### C04 — Removed runtime filesystem exports described as deprecated

**Classification:** stale; medium; high confidence. **Baseline status:** open, not repaired.

**Normative claim:** ADR-019 removes getFs, setFileSystem, SyncFileSystem and the old filesystem classes; the current root barrel exposes only the canonical factories/interface.

**Observed reality:** Runtime README says those APIs remain deprecated; its setup example still names NodeFileSystem.

**Authority resolution:** Accepted ADR-019 supersedes the old ADR-011 compatibility phase; package export source governs the shipped surface.

**False-positive challenge:** The README describes present availability, not a dated historical migration note. Intentional deprecation does not excuse references to deleted exports.

**Evidence anchors:**

| File:line | Stable search anchor / opposing claim |
| --- | --- |
| `docs/00_ADR.md:283` | ## ADR-019 |
| `packages/runtime/README.md:438` | The old `getFs()` |
| `packages/runtime/README.md:184` | // ctx.require('fileSystem') → NodeFileSystem |
| `packages/runtime/src/index.ts:5` | export type { FileStat, FileSystem } |

**Permitted repair surfaces:** packages/runtime/README.md (Runtime selection example annotation and File system abstraction closing paragraph only, plus directly conflicting occurrences of the same removed symbols).

**Repair detail and anti-drift constraints:**

ADR-019 deleted getFs/setFileSystem, FileSystem/SyncFileSystem compatibility types and old concrete classes from fs.ts. Runtime src/index.ts exports canonical FileSystem and createNodeFileSystem/createCfFileSystem instead. The setup example still comments “ctx.require('fileSystem') → NodeFileSystem”; replace the annotation with canonical FileSystem. Suggested closing paragraph: “The legacy getFs()/setFileSystem() global swap, SyncFileSystem, and old filesystem classes were removed in ADR-019. Use createNodeFileSystem(), createCfFileSystem(), or ctx.require('fileSystem') instead.”

Do not replace every occurrence of “deprecated”: createRuntimeContext and the compatibility process wrappers are distinct, intentionally retained surfaces. Runtime namespace membership cannot prove that a type-only export is absent; inspect index.ts and declarations for SyncFileSystem.

**Owner route:** Package documentation maintenance under sp-doc-evolve audit. Use the live CLI's section list/show to resolve addressable sections before writes. Package README edits are ordinary scoped documentation maintenance; numbered-doc changes use sp-doc-evolve.

**Reproduction / focused verification (from repository root):**

```sh
rg -n 'getFs|setFileSystem|SyncFileSystem|NodeFileSystem' packages/runtime/README.md packages/runtime/src/index.ts packages/runtime/src/fs.ts
rg -n 'ADR-019|Deleted the deprecated' docs/00_ADR.md
bun test packages/runtime/tests/index.test.ts packages/runtime/tests/file-system.test.ts
```

**Expected verification:** No current README instruction suggests removed exports can still be imported. Canonical factory/interface usage remains accurate; public exports are unchanged.

**Original evidence fingerprint:** `f7acb81de73dfac92795fea0fe118707b8bf96bfa76d56b658a4dcbc471fd7f5`. Fingerprint identifies the original finding; it is not proof the file remains unchanged after repair.

#### C05 — Rule-engine ExtensionRef description uses the retired absolute-path shape

**Classification:** stale; medium; high confidence. **Baseline status:** open, not repaired.

**Normative claim:** Current ExtensionRef exposes kind, authored relative path, baseDir and sourceName; task 0060 R12 requires preserving the authored path for trust validation.

**Observed reality:** README entity table still describes an absolute module path.

**Authority resolution:** Owning interface plus the completed contract migration governs current API documentation.

**False-positive challenge:** Older task 0011 intentionally kept absPath, but task 0060 superseded that implementation. The current README table has no historical qualifier.

**Evidence anchors:**

| File:line | Stable search anchor / opposing claim |
| --- | --- |
| `packages/rule-engine/README.md:39` | \| `ExtensionRef` \| |
| `packages/rule-engine/src/config/extensions.ts:19` | export interface ExtensionRef |
| `docs/tasks/0060_fix-2026-08-12-packages-secua-and-architecture-review-findin.md:84` | R12. Rule-engine and dual-workflow-engine |

**Permitted repair surfaces:** packages/rule-engine/README.md (ExtensionRef entity row).

**Repair detail and anti-drift constraints:**

Current interface in src/config/extensions.ts has readonly kind, path, baseDir and sourceName. path is preserved as authored and must be relative; baseDir is an absolute declaring directory. Resolving an absolute module target is the loader's later operation, not the reference's public input shape. Suggested row: “Extension reference: capability kind, authored relative path, absolute baseDir, and sourceName. The loader validates the authored path before resolving it.”

Task 0011 originally retained absPath intentionally; task 0060 R12 superseded that adaptation to avoid stripping traversal evidence before trust validation. Do not reopen the historic task as broken or rename the valid moduleLoader(absPath) callback parameter—its resolved input is correctly absolute.

**Owner route:** Package documentation maintenance. Use the live CLI's section list/show to resolve addressable sections before writes. Package README edits are ordinary scoped documentation maintenance; numbered-doc changes use sp-doc-evolve.

**Reproduction / focused verification (from repository root):**

```sh
rg -n 'ExtensionRef|readonly (kind|path|baseDir|sourceName)' packages/rule-engine/README.md packages/rule-engine/src/config/extensions.ts
spur task show 0060 --json
bun test packages/rule-engine/tests/config/extensions.test.ts
```

**Expected verification:** The README lists the four live fields and their relative/absolute semantics. Existing trust-gate and traversal tests remain green with no loader change.

**Original evidence fingerprint:** `386c87d253ef042168f0642666516dbc3d72672af660869a7689fe3248ccb2db`. Fingerprint identifies the original finding; it is not proof the file remains unchanged after repair.

#### C06 — Importer streaming memory guarantee omits compressed-file buffering

**Classification:** stale; medium; high confidence. **Baseline status:** open, not repaired.

**Normative claim:** The current readLines implementation determines the shipped memory behavior; task 0067 Solution explicitly accepts buffered zstd decompression.

**Observed reality:** README Streaming promises O(line) memory whenever readFileStream is present, but .jsonl.zstd bypasses it and buffers the entire decompressed file before split.

**Authority resolution:** The documented intentional implementation ceiling must qualify the usage guarantee; a source comment does not qualify the consumer README.

**False-positive challenge:** This is an accepted bounded simplification, so it does not justify a new streaming implementation. It still invalidates the unqualified README claim.

**Evidence anchors:**

| File:line | Stable search anchor / opposing claim |
| --- | --- |
| `packages/llm-jsonl-importer/README.md:67` | for **O(line) memory usage** |
| `packages/llm-jsonl-importer/src/importer.ts:736` | const decompressed = await zstdDecompress(file) |
| `packages/llm-jsonl-importer/src/zstd.ts:10` | ponytail: buffered decompression |
| `docs/tasks/0067_add-deepseek-session-source-to-ts-llm-jsonl-importer.md:118` | ponytail: buffered |

**Permitted repair surfaces:** packages/llm-jsonl-importer/README.md (Streaming section and, only if needed for consistency, adjacent DeepSeek decompression description).

**Repair detail and anti-drift constraints:**

readLines handles .jsonl.zstd first, awaiting zstdDecompress(file), then calls decompressed.split(/\r?\n/). It consults readFileStream only for uncompressed files. zstdDecompress buffers subprocess stdout and explicitly documents this simplification; task 0067 Solution accepts it. A filesystem offering readFileStream does not make compressed imports stream.

Use wording such as: “For uncompressed JSONL, readFileStream processes text one line at a time, avoiding full-file text buffering. Compressed .jsonl.zstd files currently buffer the complete decompressed text before line splitting; memory scales with decompressed size. When readFileStream is unavailable, readFile plus split also buffers the complete text.” If retaining O(line), label it the line-reader component only. Do not promise that registry discovery, checkpoint maps, ledger batches or the entire importer have O(line) memory. The approximately 100 MB source comment is an upgrade trigger, not a enforced size cap or safety guarantee. No streaming refactor, memory benchmark framework or new decompressor dependency is part of this fix.

**Owner route:** Package documentation maintenance. Use the live CLI's section list/show to resolve addressable sections before writes. Package README edits are ordinary scoped documentation maintenance; numbered-doc changes use sp-doc-evolve.

**Reproduction / focused verification (from repository root):**

```sh
rg -n 'readLines|zstdDecompress|readFileStream|decompressed.split' packages/llm-jsonl-importer/src/importer.ts
cat packages/llm-jsonl-importer/src/zstd.ts
rg -n 'Streaming|O\(line\)|buffer|zstd' packages/llm-jsonl-importer/README.md
bun test packages/llm-jsonl-importer/tests/zstd.test.ts packages/llm-jsonl-importer/tests/deepseek-importer.test.ts
```

**Expected verification:** All three actual read paths have accurate memory descriptions and unchanged execution behavior. Check uncompressed streaming tests through the full importer suite when running final verification.

**Original evidence fingerprint:** `6b449e32834982c4830dd1de925db07ba6b02c995a09423ec52d69f39e96279d`. Fingerprint identifies the original finding; it is not proof the file remains unchanged after repair.

#### C07 — Importer built-in source roster omits deepseek

**Classification:** omission; low; high confidence. **Baseline status:** open, not repaired.

**Normative claim:** SOURCE_DEFINITIONS is the built-in source registry.

**Observed reality:** README’s enumerated built-in source keys ends with agy, though deepseek is registered and documented in the next paragraph.

**Authority resolution:** Registry source governs an explicitly enumerated source-key list.

**False-positive challenge:** The next paragraph limits impact but does not make the exhaustive roster accurate; this is not a planned source.

**Evidence anchors:**

| File:line | Stable search anchor / opposing claim |
| --- | --- |
| `packages/llm-jsonl-importer/README.md:22` | Built-in source keys are |
| `packages/llm-jsonl-importer/src/sources.ts:220` |     deepseek: { |

**Permitted repair surfaces:** packages/llm-jsonl-importer/README.md (single built-in source-key sentence).

**Repair detail and anti-drift constraints:**

The baseline sentence lists claude, codex, gemini, pi, opencode, antigravity, openclaw, omp, grok and agy, while the following paragraph correctly documents deepseek. Add deepseek and compare the whole roster against the live registry; do not infer that agy and antigravity are aliases or omit one. No changes to AgentName/LlmJsonlSource, source ordering, root resolution or patterns are necessary.

**Owner route:** Package documentation maintenance. Use the live CLI's section list/show to resolve addressable sections before writes. Package README edits are ordinary scoped documentation maintenance; numbered-doc changes use sp-doc-evolve.

**Reproduction / focused verification (from repository root):**

```sh
bun -e 'import { SOURCE_DEFINITIONS } from "./packages/llm-jsonl-importer/src/sources.ts"; console.log(Object.keys(SOURCE_DEFINITIONS).sort().join("\n"));'
rg -n 'Built-in source keys are' packages/llm-jsonl-importer/README.md
```

**Expected verification:** README key set equals Object.keys(SOURCE_DEFINITIONS); deepseek appears once in that sentence. The dedicated DeepSeek paragraph remains.

**Original evidence fingerprint:** `96dbcf6ea94f80245fe7fe393453b52c2bb681da617ece874177fadb5a8850c7`. Fingerprint identifies the original finding; it is not proof the file remains unchanged after repair.

#### C08 — External authority references are not repository-qualified

**Classification:** omission; low; high confidence. **Baseline status:** open, not repaired.

**Normative claim:** Architecture/cancellation references must identify their actual owner. ADR-112, A21 and task 0734 exist in sibling spur-new, not in this repository’s ADR/task/feature corpus.

**Observed reality:** Architecture and importer README use bare ADR-112/A21/0734 references, directing local readers toward nonexistent local entries.

**Authority resolution:** Constitution routing and the conflict skill require reproducible authority provenance. External decisions are supporting provenance, not silently imported local authority.

**False-positive challenge:** Read sibling spur-new docs/00_ADR.md ADR-112, feature A21 and task in docs/tasks4/0734*. The references are real external records, so they are not invented or missing implementation.

**Evidence anchors:**

| File:line | Stable search anchor / opposing claim |
| --- | --- |
| `docs/03_ARCHITECTURE.md:72` | **Scheduler ownership (task 0734).** |
| `docs/03_ARCHITECTURE.md:114` | (feature A21 / ADR-112) |
| `packages/llm-jsonl-importer/README.md:76` | feature A21 / ADR-112 |
| `docs/00_ADR.md:360` | ## ADR-024 |

**Permitted repair surfaces:** docs/03_ARCHITECTURE.md (scheduler task 0734 reference, importer feature A21/ADR-112 reference and runtime deadline A21 reference, plus frontmatter); packages/llm-jsonl-importer/README.md (Cancellation parenthetical).

**Repair detail and anti-drift constraints:**

Verified upstream records live in the sibling spur-new repository: docs/00_ADR.md under “ADR-112: Execution Deadlines Are Upstream Policy; Unlimited Jobs Retain Renewable Ownership”; docs/features/A21_reusable-execution-deadlines-and-unlimited-jobs.md; docs/tasks4/0734_configurable-scheduler-jobs-interval-real-cron-in-ts-libs-ad.md. The original failed lookup under docs/tasks was corrected via rg --files: do not copy that wrong path. Local ts-libs ADRs end at ADR-024 at the baseline.

Qualify prose as “Spur feature A21 / Spur ADR-112” and “Spur task 0734”. Also qualify the architecture's “Owned deadline containment (A21)” occurrence. Prefer a verified repository-relative upstream identifier or actual upstream repository link; never publish a developer-specific /Users/robin absolute path in maintained package docs. Resolve the upstream remote/branch/anchor before creating URLs rather than guessing the repository slug. These are supporting provenance references, not an automatic grant of authority over ts-libs.

Other bare A21/0734 comments occur in implementation and infra README; they were outside this audit's C08 repair set. Record them as follow-up candidates if encountered; do not turn this task into a repository-wide reference rewrite. No local ADR-112 stub, cloned feature or sibling edit is needed.

**Owner route:** sp-doc-evolve for architecture; package documentation maintenance for README. Use the live CLI's section list/show to resolve addressable sections before writes. Package README edits are ordinary scoped documentation maintenance; numbered-doc changes use sp-doc-evolve.

**Reproduction / focused verification (from repository root):**

```sh
rg -n 'ADR-112|A21|0734' docs/03_ARCHITECTURE.md packages/llm-jsonl-importer/README.md
rg --files ../spur-new/docs -g '*0734*' -g '*A21*' -g '*ADR*'
rg -n 'ADR-112:' ../spur-new/docs/00_ADR.md
git -C ../spur-new remote get-url origin
```

**Expected verification:** Every in-scope reference identifies Spur, and newly introduced links point to the inspected external records. No ts-libs number is invented and no sibling file changes.

**Original evidence fingerprint:** `4c9e004c9c0784f46d621f25345223ff35c4634ab0a8f1f3bf27a182897b0840`. Fingerprint identifies the original finding; it is not proof the file remains unchanged after repair.

#### Minimal live probes

Run the following from the repository root to reproduce the two behavioral observations without mutating a real database. This is a temporary check; do not add a new test framework or committed script just to duplicate existing tests.

```sh
bun - <<'PROBE'
import { dshSplit } from './packages/llm-jsonl-importer/src/mappers.ts';
import { createDbAdapter } from './packages/db/src/adapter.ts';
import { applyHistoryImportSchema } from './packages/llm-jsonl-importer/src/jsonl-importer-dao.ts';
const header = dshSplit({ type: 'session', id: 'audit-session', createdAt: '2026-09-16T00:00:00Z', cwd: '/audit' });
console.log('header rows', header.map(x => ({ table: x.targetTable, role: x.record.role, disposition: x.record.disposition })));
const db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
try {
    await applyHistoryImportSchema(db);
    console.log('generic ETL tables', await db.queryAll('SELECT name FROM sqlite_master WHERE type = ? AND name LIKE ?', 'table', 'history_etl_%'));
} finally { await db.close(); }
PROBE
```

Baseline output: one history_message/meta/meta row; generic ETL tables []. Under the recommended documentation/authority repair this output must remain unchanged.

#### Completion evidence format

At execution completion, Solution must map each C01–C08 to current file:line edits or an evidenced already-fixed disposition. Testing must record actual command results, not this baseline. Review must evaluate both semantic agreement and the file/section allowlist. A “tests pass” summary alone does not close a documentation contradiction. Maintain a per-finding table: ID, approved decision, changed anchors, focused verification, disposition, residual uncertainty. Mark done only through the ordinary lifecycle with fresh verification. If one decision remains unresolved, report partial and leave the task nonterminal.

#### Baseline file fingerprints

Whole-file SHA-256 values captured by the audit and matched again at task creation. A mismatch during execution means re-read/re-audit; it does not imply corruption and is not a reason to overwrite someone else's work.

| File | SHA-256 |
| --- | --- |
| `docs/features/I_add-deepseek-dsh-coding-agent-support.md` | `4478fadffed6a17cbdf34031484e59cbe6fc7900e267eb4c77060d5272e360c4` |
| `docs/tasks/0067_add-deepseek-session-source-to-ts-llm-jsonl-importer.md` | `f4c520666197dcf535f4b8d4f369d6114eeb844c2bd9914e6b49003be3252961` |
| `packages/llm-jsonl-importer/src/mappers.ts` | `b329061851c85f2d3bfc1efd815cf9e6da1b38876efa723a3438d208651c4130` |
| `packages/llm-jsonl-importer/tests/deepseek-importer.test.ts` | `54210512877ad78ecffecf21a769c80626c2c20a56bf2bc04dea7c26ab8848b5` |
| `CHANGELOG.md` | `986860c0510f0254809ad39306a464c55da56a8fc00412a897bd47b6ff050ea1` |
| `docs/00_ADR.md` | `3bf3445db39ec7aade00afed6a96b28e5de1d099d770fb483ef7379c62bcb806` |
| `docs/tasks/0061_fix-packages-review-session-bottlenecks-skill-path-drift-dua.md` | `41f79e524f83a484c500c2d32e09c221277811fd0b5be9be6d4ed9f1bf561b9e` |
| `packages/llm-jsonl-importer/src/jsonl-importer-dao.ts` | `b5795cc88b5295f8373486934284f0f2da8cc394a49284c79cb0274b959fe6d3` |
| `packages/llm-jsonl-importer/tests/jsonl-importer-dao.test.ts` | `88d9dc45ccef7453b436cfd9c063988157676518ace5bafd02826509828a17df` |
| `docs/features/E_ts-llm-jsonl-importer.md` | `7e70765728d34ccd1e721fff196f46e06d66bd434414e2f640ec06985fb8de62` |
| `docs/tasks/0064_retain-forensic-tool-call-metadata-in-ts-llm-jsonl-importer-.md` | `b36dba9e89371ef776ddef941deb16475329e9037b0bd60d5baea4e415da8540` |
| `docs/tasks/0066_add-deepseek-dsh-shim-to-ts-ai-runner.md` | `27022478cb16cfabe5cec301e4c7e7343bd8a8635be0df3cedba021142860848` |
| `docs/05_FEATURES.md` | `7cadb8e25832deb3e08fa2870ca3cfd455e55f9bf43ad7e3ed42b6e1544e629d` |
| `docs/features/INDEX.md` | `e0701f23b1657b281a468a0742ee3c56e0630727e2c0498ac5cd883a641613af` |
| `packages/runtime/README.md` | `f97fcd509b952a9a9b9fd65b7476168fc6b29186927eec513727403b940dfc77` |
| `packages/runtime/src/index.ts` | `21ec8f43488ae13b52fb83eacc802a74b3f4aee87e6234112204485e894a866d` |
| `packages/rule-engine/README.md` | `0a9f1d76472d2411d205fceb32a60cd074b22a0396eff89d807ade10914de8a5` |
| `packages/rule-engine/src/config/extensions.ts` | `3db64305fe457547c7d19ac51f9877b5863120fd155153e656e54aee255b26fb` |
| `docs/tasks/0060_fix-2026-08-12-packages-secua-and-architecture-review-findin.md` | `458d3f463860d829a912b55364fffa74062103fb6b297bc97fe52cf7c75a72a5` |
| `packages/llm-jsonl-importer/README.md` | `93d7e7b51b1624cc3a3e8804357097600d57bb5e066c452a6c95613f8838cffb` |
| `packages/llm-jsonl-importer/src/importer.ts` | `d9f018adb6bdaee420d02482dc61c00542e4f5587ed51f93c9a193b57da77029` |
| `packages/llm-jsonl-importer/src/zstd.ts` | `592b09862e4f8e17d656a44dcaf249f37ccccb573b9c45e67ccd6ed79472dfba` |
| `packages/llm-jsonl-importer/src/sources.ts` | `68f3df1ce6f5e1881607a52ae5525078a710a5e416c816a46f86df1554f6548c` |
| `docs/03_ARCHITECTURE.md` | `5c503b1c4ef852d82b8786b27bf20d54393210aa2bbf652d7e3aea6ef9000abe` |

### Plan

1. [x] Read AGENTS.md, constitution, applicable ADRs, this task and the current targeted source/doc/corpus sections. Run git status; preserve other work. Resolve corpus paths using spur task/feature show and query addressable sections. Revalidate all eight findings; use fingerprints as drift indicators.
2. [x] Record the execution session's explicit C01 and C02 choices. Recommended: retain DeepSeek metadata and lazy ETL creation. If a behavior-changing alternative is selected, amend the task scope/design/AC through Spur before implementation. Do not treat this task's creation as acceptance.
3. [x] Apply C02 authority-first: dated ADR-023 amendment, then task 0061 dated supersession note; preserve historic acceptance and release records. Confirm fresh schema-only probe still matches the selected behavior.
4. [x] Apply C01 feature contract first, then align task 0067 prose, current release description and dshSplit docblock. Preserve header metadata and importedRecords semantics under the recommended direction. Run the existing DeepSeek/zstd tests.
5. [x] Apply C04 and C05 to the exact runtime/rule-engine README sentences; compare exports/interface and run the relevant existing tests. No compatibility implementation or loader edits.
6. [x] Apply C06 and C07 to importer README in one scoped edit; qualify the line-reader memory behavior and compare the source-key roster to the live registry. Leave decompression/registry code intact.
7. [x] Apply C08 repository qualification to the targeted architecture/README references after verifying the actual upstream records. Update numbered-doc version/date only on the affected documents. Do not edit upstream files.
8. [x] Apply C03 through scoped feature refresh for E and I after corpus edits; then align the numbered feature summary with current feature status. Include this task in E's generated roster if still linked. Do not close I or run a broad feature sync.
9. [ ] Review the final diff against each finding and the allowlist. Run the minimal probes and any focused checks not already covered by a fresh passing run. Run bun run spur-check and bun run build; validate this task plus affected features. Report legacy corpus failures separately and do not repair them in this task.
10. [ ] Record a current C01–C08 disposition/evidence table in the ordinary lifecycle sections, perform the review and verify gates, and advance status only if all authorized requirements/AC are satisfied. Leave any unresolved decision explicit rather than declaring full completion.

### Solution

Implemented the C01–C08 repair as a bounded documentation/authority reconciliation. Direction authorized by the execution-session decision recorded in this task's Q&A (`2026-09-16` entry): C01 retains the DeepSeek session-header metadata row, C02 keeps lazy ETL materialization. No source logic, schema, export, API, or dependency change — the only non-documentation edit is one mapper docblock.

#### Evidence freshness (R9)

Before any write, all 24 baseline file fingerprints in Design were recomputed with `shasum -a 256`: every one matched the audit table, so no finding was already-fixed, stale, or invalidated by later drift, and no baseline line number was applied mechanically. Anchors below are current post-edit locations; baseline locators were used only to find the claims.

#### Change map

| Finding | Req | Change — `file:line` | Rationale |
| --- | --- | --- | --- |
| C01 | R1 | `docs/features/I_add-deepseek-dsh-coding-agent-support.md:28` (Scope log-format bullet), `:31` (test-scope bullet), `:73` (AC R5); `docs/tasks/0067_add-deepseek-session-source-to-ts-llm-jsonl-importer.md:28` (R2), `:49` (AC R5), `:99`/`:102` (Design), `:85` (appended dated clarification); `CHANGELOG.md:34`; `packages/llm-jsonl-importer/src/mappers.ts:1450-1452` (dshSplit docblock) | The feature AC is the authority and now states the shipped contract: one `history_message` metadata row (`role=meta`, `disposition=meta`) carrying session id, `cwd`, `createdAt`, plus the user/assistant rows; the fixture stays three imported records and `importedRecords` counting is unchanged. Task 0067's Requirements/AC/Design were aligned to the amended AC; its Testing PASS receipt is preserved untouched as history, and the appended Q&A clarification quotes the superseded "is skipped" wording and records what the code does. CHANGELOG's "skip the per-session header meta line" was an incorrect account of what 0.4.63 shipped. The docblock above the `recordType === 'session'` branch no longer claims only chat events become `history_message` rows. |
| C02 | R2 | `docs/00_ADR.md:358-362` (dated ADR-023 amendment), `:6`/`:8` (frontmatter); `docs/tasks/0061_fix-packages-review-session-bottlenecks-skill-path-drift-dua.md:122` (appended dated supersession note) | ADR-023 is authoritative and append-only, so the live contract lands as a dated `**Amendment**` superseding only the 2026-08-12 R16 eager-materialization guarantee; R1 (no `history_etl_*` CREATE in the static SQL) and the single-owner `ETL_TABLE_DDL` direction stay in force. Task 0061's historical R2/R3 acceptance record and PASS receipt are preserved — the note explains that commit `22f891f8` superseded the eager guarantee later, without erasing or unchecking the original. No source edit: `applyHistoryImportSchema` and the importer README already describe lazy materialization. |
| C03 | R3 | `docs/features/E_ts-llm-jsonl-importer.md:31-32` (refreshed roster); `docs/features/I_add-deepseek-dsh-coding-agent-support.md:105-106` (refreshed roster); `docs/05_FEATURES.md:35` (feature I summary row), `:6`/`:9` (frontmatter) | `spur feature refresh --feature E` and `--feature I` rebuilt both `## Tasks` regions from current task frontmatter after the corpus edits: E lists 0063/0064/0068 (0068 still linked and still `todo`), I lists 0066/0067 as `done`. `docs/features/INDEX.md` was regenerated by the tool and is byte-identical (both features were already indexed). Feature I enters the numbered summary with its real `active` lifecycle status (🔶 partial) and satellite pointer; no feature lifecycle was advanced. |
| C04 | R4 | `packages/runtime/README.md:184` (runtime-selection annotation), `:438-440` (filesystem closing paragraph) | ADR-019 deleted `getFs`/`setFileSystem`/`SyncFileSystem` and the old filesystem classes, and `packages/runtime/src/index.ts:5-7` exports only the canonical `FileSystem` type plus `createNodeFileSystem`/`createCfFileSystem`. The example annotation and the closing paragraph now say removed-by-ADR-019 and point at the canonical factories. The intentionally retained `createRuntimeContext()` deprecation (`:189`) and the deprecated process wrappers (`:641`) are untouched; no removed export was restored. |
| C05 | R5 | `packages/rule-engine/README.md:39` (ExtensionRef entity row) | Matches the live interface `packages/rule-engine/src/config/extensions.ts:19-28`: `kind`, authored relative `path`, absolute `baseDir`, `sourceName`, with the loader validating the authored path before resolving it. `absPath`/`presetName` are not reintroduced and the loader is unchanged. |
| C06 | R6 | `packages/llm-jsonl-importer/README.md:64-80` (Streaming section) | `readLines` (`packages/llm-jsonl-importer/src/importer.ts:731-750`) handles `.jsonl.zstd` first via `zstdDecompress` (`:736`) and consults `readFileStream` only for uncompressed files; `zstdDecompress` buffers subprocess stdout (`packages/llm-jsonl-importer/src/zstd.ts:10-11`). The section now bounds `O(line)` to the line-reading component, names both full-text-buffering paths (compressed files, and the `readFile` + split fallback when `readFileStream` is absent), and states that discovery/checkpoint/ledger memory is outside the claim. No streaming refactor, no new decompressor dependency, no size-cap claim. |
| C07 | R7 | `packages/llm-jsonl-importer/README.md:22` (built-in source-key sentence) | `deepseek` added to the roster. Compared against the live registry (`packages/llm-jsonl-importer/src/sources.ts`, `SOURCE_DEFINITIONS`): the clause now equals `Object.keys(SOURCE_DEFINITIONS)` exactly — agy, antigravity, claude, codex, deepseek, gemini, grok, omp, openclaw, opencode, pi — each once, with `agy` and `antigravity` kept as distinct identities. Registry ordering, patterns, and the source unions are unchanged. |
| C08 | R8 | `docs/03_ARCHITECTURE.md:72` (task 0734), `:114` (feature A21 / ADR-112), `:140` (second A21 deadline paragraph), `:6`/`:9` (frontmatter); `packages/llm-jsonl-importer/README.md:84` (Cancellation parenthetical) | Every in-scope reference now names Spur as owner and links the inspected upstream record. Upstream paths were verified before linking: `docs/tasks4/0734_configurable-scheduler-jobs-interval-real-cron-in-ts-libs-ad.md`, `docs/features/A21_reusable-execution-deadlines-and-unlimited-jobs.md` and the ADR-112 heading in `docs/00_ADR.md` all exist on `origin/main` of `gobing-ai/spur`, and all three URLs return HTTP 200. No local ADR-112 stub, cloned feature, or sibling-repo edit; no developer-absolute path published. |

#### Follow-up candidates (recorded, not repaired)

Out of this task's C08 repair set by Design: bare `A21`/`0734` references remain in implementation comments and one package README — `packages/llm-jsonl-importer/src/importer.ts:133,488`, `packages/llm-jsonl-importer/src/cancellation.ts:4`, `packages/llm-jsonl-importer/src/types.ts:98`, `packages/llm-jsonl-importer/src/opencode-importer.ts:48,59`, `packages/llm-jsonl-importer/src/errors.ts:14`, `packages/runtime/tests/process-executor.test.ts:421`, and `packages/infra/README.md:284,344` plus the `packages/infra`/`packages/db` source and test comments surfaced by `rg -n 'ADR-112|\bA21\b|0734'`. They are candidates for a separate repository-wide provenance pass, not part of this bounded repair.

#### Exclusions honored

No U01 bulk task migration or historical-record normalization; no dependency/export/API/schema change; no streaming refactor; no new test framework, runtime, or formatter; no release/publish/commit/push; no `.github/workflows` change; no automatic feature closure; no sibling-repository mutation. Task 0061's and 0067's historical verdicts and PASS receipts are preserved (0067's Testing section is untouched); 0067's remaining "skip"-era phrases are the preserved receipt and the original refinement Q&A entry, both now explicitly labeled superseded by the appended clarification.

#### Focused verification performed during implementation

| Check | Result |
| --- | --- |
| `shasum -a 256` over all 24 baseline files | 24/24 matched the audit fingerprints — no drift |
| Minimal probe: `dshSplit({type:'session',…})` | one `history_message` row, `role=meta`, `disposition=meta` (unchanged behavior) |
| Minimal probe: `applyHistoryImportSchema` on fresh `:memory:` | generic ETL tables `[]` (lazy contract holds) |
| `bun test packages/llm-jsonl-importer/tests/{deepseek-importer,zstd,jsonl-importer-dao,schema-sql}.test.ts` | 37 pass / 0 fail |
| `bun test packages/runtime/tests/{index,file-system}.test.ts packages/rule-engine/tests/config/extensions.test.ts` | 24 pass / 0 fail |
| `bunx biome check packages/llm-jsonl-importer/src/mappers.ts` | clean |
| `spur task check 0061 / 0067 / 0068` | all `pass: true` (pre-existing baseline warnings only) |
| `spur feature check E / I` | both `pass: true` |
| README roster vs `Object.keys(SOURCE_DEFINITIONS)` | set-equal, 11 keys, no duplicates |
| Upstream C08 links (3 URLs) | HTTP 200 each |

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | Feature I Scope + AC R5 state the retained metadata row (`docs/features/I_add-deepseek-dsh-coding-agent-support.md:28`, `:73`); task 0067 R2/AC/Design aligned + dated 2026-09-16 clarification (`docs/tasks/0067_add-deepseek-session-source-to-ts-llm-jsonl-importer.md:28`, `:49`, `:85`); `CHANGELOG.md:33` restated to the shipped contract; `dshSplit` docblock re-read `packages/llm-jsonl-importer/src/mappers.ts:1450-1458` — header persisted as one `history_message` meta row. Fresh focused test run: 54 pass / 0 fail (`deepseek-importer.test.ts` asserts 3 imported records). |
| R2 | MET | Dated `**Amendment (2026-09-16, task 0068 C02)**` re-read at `docs/00_ADR.md:358-362` — supersedes only the R16 eager guarantee; 0061 supersession note re-read `docs/tasks/0061_fix-packages-review-session-bottlenecks-skill-path-drift-dua.md:119-124` (preserves historical PASS receipt, cites `22f891f8`); ADR frontmatter 1.1.0 / 2026-09-16 (`docs/00_ADR.md:6`). |
| R3 | MET | E roster `docs/features/E_ts-llm-jsonl-importer.md:31-33` = 0063/0064/0068 all `done`; I roster `docs/features/I_add-deepseek-dsh-coding-agent-support.md:105-106` = 0066/0067 `done`; both equal fresh `spur task list --feature E/I --json` this run. `docs/05_FEATURES.md:35` carries feature I as 🔶 partial with satellite pointer; feature I frontmatter `status: active` unchanged — no lifecycle advanced. |
| R4 | MET | `packages/runtime/README.md:184` annotates canonical `FileSystem`; `:438-440` states `getFs`/`setFileSystem`/`SyncFileSystem`/old classes "were removed in ADR-019"; `packages/runtime/src/index.ts:5-7` exports only `FileSystem` type + `createNodeFileSystem`/`createCfFileSystem`; fresh `rg 'getFs\|setFileSystem\|SyncFileSystem' packages/runtime/src` → exit 1 (none); retained deprecations at `:189`, `:641` untouched. |
| R5 | MET | `packages/rule-engine/README.md:39` row matches interface `packages/rule-engine/src/config/extensions.ts:19-28` field for field (kind, authored relative path, absolute baseDir, sourceName, validate-before-resolve); fresh `rg 'absPath\|presetName' packages/rule-engine/README.md` → exit 1; loader unmodified; `extensions.test.ts` green in focused run. |
| R6 | MET | `packages/llm-jsonl-importer/README.md:64-80` bounds O(line) to the line reader and names both full-text-buffering paths; code re-read `packages/llm-jsonl-importer/src/importer.ts:731-750` (zstd whole-decompress first, `readFileStream` for uncompressed, `readFile`+split fallback) and `packages/llm-jsonl-importer/src/zstd.ts:10-11` (documented buffered ceiling); no streaming refactor in diff. |
| R7 | MET | Fresh probe: `Object.keys(SOURCE_DEFINITIONS)` = agy,antigravity,claude,codex,deepseek,gemini,grok,omp,openclaw,opencode,pi (11 keys); README roster `packages/llm-jsonl-importer/README.md:22` set-equal, each once, agy/antigravity distinct; `sources.ts` unmodified. |
| R8 | MET | All four occurrences Spur-qualified, re-read: `docs/03_ARCHITECTURE.md:72` (Spur task 0734), `:114` (Spur feature A21 / Spur ADR-112), `:140` (Spur A21), `packages/llm-jsonl-importer/README.md:84` (Spur A21 / Spur ADR-112); no local stub records introduced. |
| R9 | MET | Dated decision records exist and precede the edits: C01/C02 directions in task Q&A 2026-09-16 entries; corpus mutations via owner surfaces (roster regions tool-regenerated, AUTO-GENERATED markers intact); numbered-doc frontmatter bumped (`docs/00_ADR.md` 1.1.0, `docs/03_ARCHITECTURE.md` 1.2.0, `docs/05_FEATURES.md` 1.3.0, all 2026-09-16); ADR numbers/history preserved (append-only amendment). |
| R10 | MET | Fresh gates this run: `bun run spur-check` exit 0 (Biome + 8× `tsc --noEmit` + 49 pre-check rules `--fail-on warning` + `bun test --coverage` 2250 pass / 0 fail + 2 post-check rules); `bun run build` exit 0 for all 8 packages; focused suite 54 pass / 0 fail; `spur task check 0068 --strict-core` pass, zero findings; `git status --porcelain` clean — diff bounded to the C01–C08 allowlist. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| Scenario: R1 — DeepSeek header contract matches its approved behavior | MET | test | `bun test packages/llm-jsonl-importer/tests/deepseek-importer.test.ts` → pass (3 imported records, meta row + 2 keep rows); claims re-read at `docs/features/I_add-deepseek-dsh-coding-agent-support.md:73`, `packages/llm-jsonl-importer/src/mappers.ts:1450-1458` |
| Scenario: R2 — ETL creation authority is reconciled before projections | MET | command | `sed -n '355,363p' docs/00_ADR.md` → dated amendment present; `jsonl-importer-dao.test.ts` green (zero `history_etl_*` after schema-only setup) |
| Scenario: R3 — Feature rosters and numbered summary reflect current corpus | MET | command | `spur task list --feature E --json` / `--feature I --json` equal rosters at `docs/features/E_ts-llm-jsonl-importer.md:31-33` and `docs/features/I_add-deepseek-dsh-coding-agent-support.md:105-106`; `docs/05_FEATURES.md:35` |
| Scenario: R4 — Runtime documentation no longer advertises removed filesystem APIs | MET | command | `rg 'getFs\|setFileSystem\|SyncFileSystem' packages/runtime/src` → exit 1; `packages/runtime/README.md:438-440` states removed-in-ADR-019 |
| Scenario: R5 — ExtensionRef usage documents the authored-path contract | MET | test | `packages/rule-engine/tests/config/extensions.test.ts` green; README `:39` vs `extensions.ts:19-28` field-equal |
| Scenario: R6 — Streaming documentation exposes both buffering exceptions | MET | command | `sed -n '62,82p' packages/llm-jsonl-importer/README.md` + `sed -n '730,751p' packages/llm-jsonl-importer/src/importer.ts` (this run) — both buffering paths named in README, code confirms zstd-first/stream/readFile branches |
| Scenario: R7 — Built-in source roster is complete | MET | command | `bun -e "import {SOURCE_DEFINITIONS}..."` → 11 keys incl. deepseek, set-equal to `packages/llm-jsonl-importer/README.md:22` |
| Scenario: R8 — Cross-repository authority provenance is explicit | MET | command | `sed -n '70,74p;112,116p;138,142p' docs/03_ARCHITECTURE.md` + `sed -n '83,86p' packages/llm-jsonl-importer/README.md` (this run) — all four occurrences name Spur as owner with verified upstream links |
| Scenario: R9 — Fresh evidence and owner routing preserve authority and history | MET | command | `sed` re-reads (this run) of the 2026-09-16 Q&A decision records in `docs/tasks/0067_...md:85` and `docs/tasks/0061_...md:119-124`; AUTO-GENERATED roster markers intact at `docs/features/E_ts-llm-jsonl-importer.md:34`; append-only amendment at `docs/00_ADR.md:358-362` |
| Scenario: R10 — Fresh verification and the bounded diff establish completion | MET | command | `bun run spur-check` exit 0 (2250 pass / 0 fail, 49+2 rules); `bun run build` exit 0 (8/8); `git status` clean |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

#### Review Report — 0068 (round-3 re-review after the C01 residual remediation)

**Scope:** task-0068 diff — 13 uncommitted changed files vs `HEAD` (`ec78378`): `CHANGELOG.md`, `docs/00_ADR.md`, `docs/03_ARCHITECTURE.md`, `docs/05_FEATURES.md`, `docs/features/E_ts-llm-jsonl-importer.md`, `docs/features/I_add-deepseek-dsh-coding-agent-support.md`, `docs/tasks/0061_*.md`, `docs/tasks/0067_*.md`, `docs/tasks/0068_*.md`, `packages/llm-jsonl-importer/README.md`, `packages/llm-jsonl-importer/src/mappers.ts` (docblock only), `packages/rule-engine/README.md`, `packages/runtime/README.md`
**Dimensions:** functional traceability, security, efficiency, correctness, usability, architecture
**Verdict:** PASS — zero P1/P2/P3 findings. The bounded C01–C08 repair is behavior-preserving, traceable to the live sources, and inside its document/section allowlist. The round-2 residual (labelled below) is independently verified repaired. Scope note: this PASS covers the C01–C08 repair patch; it does not assert closure of task requirement R10, which remains PENDING as the verify stage's corpus-recording obligation (finding #1).

**Round context (stated, not re-litigated).** Round-2 review and round-2 verify both found one residual: the 2026-09-11 Q&A bullet in task 0067 carried an unlabelled "header-skip" rationale while the shipped mapper persists the header as a `meta` row. The pipeline's bounded remediation hop repaired it; `spur task check 0067` is PASS and the quality gate has since re-run green (2,250 pass / 0 fail, 49 pre-check + 2 post-check rules) with `bun run build` green for all 8 packages. Re-verified fresh this round, not carried: `docs/tasks/0067_add-deepseek-session-source-to-ts-llm-jsonl-importer.md:81` now ends with an inline qualifier — "*(Superseded 2026-09-16 by the clarification below: the shipped mapper retains the `type:"session"` header as one `meta` row rather than skipping it.)*" — and the 2026-09-16 clarification at `:85` states what the code does. That prior finding is **closed**, and R1's "every occurrence corrected or clearly labelled superseded" expectation is now met for the Q&A surface. No new P1–P3 class was found anywhere in the diff.

##### Findings (ranked)

| # | Priority | Dimension | Finding | Location |
|---|----------|-----------|---------|----------|
| 1 | P4 (advisory) | functional | R10's corpus recording is still owed: `### Testing` is the untouched template and all ten requirement boxes R1–R10 plus Plan steps 9–10 are unchecked (`grep -c '^- \[ \]'` = 10). This is the verify stage's write, not a defect of the patch — but if the boxes are still unchecked at the terminal transition, F1 (zero unchecked boxes) fails. Pipeline-supplied evidence for this round is green (2,250 pass / 0 fail; `bun run build` green for 8 packages). | `docs/tasks/0068_resolve-package-contract-and-documentation-conflicts-c01-c08.md:613`, `:33-42` |
| 2 | P4 (advisory) | usability | The new Spur ADR-112 links target the whole upstream `docs/00_ADR.md` with no `#fragment`, forcing a ~1.6k-line search for a heading that has a stable anchor. Durability point, unchanged from round 2: all three C08 links pin `blob/main`, a moving ref, so an upstream rename silently 404s the cross-repo provenance; a commit-SHA permalink would not drift. | `docs/03_ARCHITECTURE.md:114`, `packages/llm-jsonl-importer/README.md:84` |
| 3 | P4 (advisory) | architecture | The ADR-023 amendment body inlines implementation symbols (`applyHistoryImportSchema`, `ETL_TABLE_DDL`) and its `Detail:` pointer names a package README plus a source file, while `99` §6.1 rule 8 routes mechanism to `03`/`04`/plans. Verified again this round: `:362` is the **only** `Detail:` line in `docs/00_ADR.md`, so the 4-line body sets a convention rather than following one, and it stays under rule 8's "more than a few lines" threshold. Low impact; a `03`/`04` pointer would conform. | `docs/00_ADR.md:358-362` |
| 4 | P4 (advisory) | correctness | Historical CHANGELOG entries still carry claims the new authority supersedes, both re-confirmed verbatim: eager ETL materialization ("created solely by `ETL_TABLE_DDL` / `ensureTargetTables` looping `SOURCE_DEFINITIONS`") and the unqualified `O(line)` multi-GB streaming promise. Both were accurate at their release time — unlike `:34`, which was wrong at ship time and therefore in C01's scope — and both sit outside the C02/C06 allowlists by design. Recorded as follow-up candidates, not defects of this patch. | `CHANGELOG.md:254`, `CHANGELOG.md:722` |
| 5 | P4 (advisory) | correctness | The last literal skip-era phrase outside a label is inside task 0067's preserved PASS receipt: the AC R5 evidence row reads "header line skipped to meta row". It is a historical receipt (the task's Design and this task's Solution both require preserving it unchanged), it self-acknowledges the meta row, and the `:85` clarification designates "the PASS receipt in Testing" as the preserved historical record — so it is covered section-level, just not inline. An optional one-word inline qualifier would spare a reader who lands directly in `### Testing`. | `docs/tasks/0067_add-deepseek-session-source-to-ts-llm-jsonl-importer.md:157` |

##### Functional Traceability

| Req | Status | Evidence |
|-----|--------|----------|
| R1 (C01) | MET | Feature I Scope (`docs/features/I_…:28`, `:31`) and AC R5 (`:73`) state the retained metadata row; task 0067 R2 (`:28`), AC R5 (`:49`) and Design (`:99`, `:102`) are aligned; the 2026-09-11 Q&A bullet now carries an inline superseded label (`:81`) above the dated clarification (`:85-89`); `CHANGELOG.md:34` restated to the shipped contract; `dshSplit` docblock rewritten (`packages/llm-jsonl-importer/src/mappers.ts:1450-1452`). Fresh probe this round: `dshSplit({type:'session',version:3,id:'sess-1',cwd:'/tmp/proj',createdAt:'2026-09-11T00:00:00Z'})` → exactly **1** entry, `targetTable: history_message`, `role: meta`, `record_type: session`, `disposition: meta`, `cwd`/`ts` carried, `content_text: null` — matching feature I's three-record fixture claim. Residual: finding #5 (receipt phrase only). |
| R2 (C02) | MET | Dated `**Amendment (2026-09-16, task 0068 C02)` inside ADR-023 supersedes only the R16 eager guarantee and leaves the 2026-08-12 addendum readable (`docs/00_ADR.md:358-362`); dated supersession note appended to historical task 0061 with its R2/R3 acceptance record and PASS receipt untouched (`docs/tasks/0061_…:119-124`); frontmatter `1.0.0`→`1.1.0`, `2026-08-12`→`2026-09-16`. Fresh probe this round: `HISTORY_IMPORT_SCHEMA_SQL` CREATE targets = `history_import_checkpoint`, `history_import_ledger`, `history_message`, `history_tool_call`, `history_skill_call` — **no** `history_etl_*`; `applyHistoryImportSchema` (`src/jsonl-importer-dao.ts:134-141`) executes that static SQL only, and generic targets come from `ensureTargetTable` (`:144-147`) applying `ETL_TABLE_DDL` on an accepted row. No source/test edit. |
| R3 (C03) | MET | E roster (`docs/features/E_…:31-33`) = 0063 `done`, 0064 `done`, 0068 `wip`; I roster (`docs/features/I_…:105-106`) = 0066 `done`, 0067 `done`; both equal `spur task list --feature E --json` freshly read this round (`0063 done`, `0068 wip`, `0064 done`). 0064 is no longer missing; 0066/0067 reflect current `done`. Feature I enters the numbered summary with its real lifecycle status — `docs/05_FEATURES.md:35` = `🔶 partial`, the same `active`→partial mapping the existing E row uses — plus satellite pointer. No lifecycle advanced: I's frontmatter `status: active` is unchanged vs `HEAD`. `docs/features/INDEX.md` is byte-identical to `HEAD` (`git diff --quiet` → clean). |
| R4 (C04) | MET | Annotation now reads `canonical FileSystem (createNodeFileSystem)` (`packages/runtime/README.md:184`); the closing paragraph states the legacy `getFs()`/`setFileSystem()` swap, `SyncFileSystem` and the old classes "were removed in ADR-019" and points at the canonical factories (`:438-440`). Verified against authority: `docs/00_ADR.md:283-294` (ADR-019) deletes the `FileSystem`/`SyncFileSystem` interfaces, `NodeFileSystem`/`NodeSyncFileSystem`/`CloudflareFileSystem` classes and the `getFs()`/`setFileSystem()` singletons; `packages/runtime/src/index.ts:5-7` exports only the `FileSystem` type plus `createCfFileSystem`/`createNodeFileSystem`, and a fresh grep over `packages/runtime/src` finds no `getFs`/`setFileSystem`/`SyncFileSystem` export. Retained deprecations untouched (`:189` `createRuntimeContext`, `:641` process wrappers); no export restored. |
| R5 (C05) | MET | Entity row now reads capability kind + "the authored relative path" + the absolute declaring `baseDir` + `sourceName` + pre-resolution validation (`packages/rule-engine/README.md:39`), matching `src/config/extensions.ts:19-28` field-for-field (`kind`, `path`, `baseDir`, `sourceName`, with the `assertRelativeExtensionPath` trust comment). No `absPath`/`presetName` reintroduced; loader unchanged. |
| R6 (C06) | MET | `packages/llm-jsonl-importer/README.md:64-80` bounds `O(line)` to "the line-reading component", names both full-text-buffering paths (whole-file `zstd` decompression; `readFile` + split when `readFileStream` is absent) and states registry discovery / checkpoint maps / ledger batches are outside the claim. Verified against source: `readLines` (`src/importer.ts:731-750`) handles `.jsonl.zstd` → `zstdDecompress` first (`:736`), then `fileSystem.readFileStream`, then `readFile` + `split`; `src/zstd.ts:9-16` documents the buffered ceiling. No streaming refactor, no new decompressor dependency, no size-cap promise. |
| R7 (C07) | MET | README roster (`README.md:22`) = `claude, codex, gemini, pi, opencode, antigravity, openclaw, omp, grok, agy, deepseek`. Fresh runtime extraction this round: `Object.keys(SOURCE_DEFINITIONS).sort()` = `agy, antigravity, claude, codex, deepseek, gemini, grok, omp, openclaw, opencode, pi` — **set-equal, 11 keys, no duplicates**, no ordering claim made; `agy`/`antigravity` remain distinct; registry untouched. |
| R8 (C08) | MET | All four in-scope references are Spur-qualified (`docs/03_ARCHITECTURE.md:72`, `:114`, `:140`; `packages/llm-jsonl-importer/README.md:84`) and a fresh grep finds no bare `A21`/`ADR-112`/`0734` left in either scoped document. Upstream re-verified this round against the sibling clone: `git -C ../spur-new cat-file -e origin/main:<path>` → EXISTS ×3 for `docs/tasks4/0734_configurable-scheduler-jobs-interval-real-cron-in-ts-libs-ad.md`, `docs/features/A21_reusable-execution-deadlines-and-unlimited-jobs.md`, `docs/00_ADR.md`; `origin` = `https://github.com/gobing-ai/spur.git`; upstream ADR-112 heading at `00_ADR.md:1621`. No local ADR-112 stub, no cloned feature, no sibling-repo edit, no developer-absolute path published. Residuals: finding #2. |
| R9 | MET | Baseline fingerprints re-verified independently, not trusted: all 24 rows of the Design fingerprint table (`docs/tasks/0068_…:525-553`) recomputed as `git show HEAD:<file> \| shasum -a 256` → **24/24 exact match, 0 mismatches**, so no finding was already-fixed or drift-invalidated. Authorization (`:118`) is dated 17:32:37, before every dependent edit; corpus writes went through `spur task` / `spur feature refresh`; authority (ADR-023 amendment) precedes projections (feature/task prose, rosters); ADR-023, task 0061 and task 0067 history preserved (0067's Testing receipt byte-identical to `HEAD`); numbered-doc frontmatter version **and** date bumped on all three affected docs (`00` 1.0.0→1.1.0, `03` 1.1.0→1.2.0, `05` 1.2.0→1.3.0, each `updated_at: 2026-09-16`); `INDEX.md` untouched. |
| R10 | PENDING | Not due at this stage. Pipeline-supplied for this round: quality gate green (2,250 pass / 0 fail; 49 pre-check + 2 post-check rules) and `bun run build` green for all 8 packages — not re-run here. Not yet recorded in the task (`### Testing` empty, R1–R10 unchecked) — the verify stage owns the gate run and the box/evidence writes. Fresh evidence this review did produce: `bun test` over deepseek-importer, zstd, rule-engine extensions and runtime index → **35 pass / 0 fail, 76 expect() calls**; `spur task check 0061 / 0067 / 0068` → all PASS; `spur feature check E / I` → both PASS. See finding #1. |

##### Allowlist / exclusion check

Every changed file maps to a permitted repair surface in Design (C01: feature I, task 0067, CHANGELOG, mapper docblock; C02: ADR-023 + task 0061; C03: feature E/I generated rosters + `05_FEATURES`; C04: runtime README; C05: rule-engine README; C06/C07/C08: importer README; C08: `03_ARCHITECTURE`), plus task 0068's own Q&A/Solution/Plan/Review writes. Fresh `git status --porcelain` shows exactly those 13 modified files and **no untracked artifacts**. The `mappers.ts` change is provably comment-only (zero non-comment `+`/`-` lines in the hunk). No test file was touched, so nothing was weakened or skipped; no `.github/workflows`, dependency, export, API, schema or streaming change. Unqualified `A21`/`0734` references that remain in source and other packages — re-confirmed present at `packages/llm-jsonl-importer/src/importer.ts:133,488`, `src/cancellation.ts:4`, `src/types.ts:98`, `src/errors.ts:14`, `src/opencode-importer.ts:48,59`, `packages/runtime/tests/process-executor.test.ts:421`, `packages/infra/README.md:284,344` — are exactly the C08 follow-ups the implementer recorded, consistent with Design's explicit exclusion of a repository-wide provenance pass.

##### Fresh verification performed this round

| Check | Result |
| --- | --- |
| 24 baseline fingerprints vs `git show HEAD:<file>` | 24/24 exact, 0 mismatch |
| Probe `dshSplit({type:'session',…})` | 1 entry — `history_message`, `role=meta`, `record_type=session`, `disposition=meta`, `content_text: null`, `cwd`/`ts` carried |
| Probe `HISTORY_IMPORT_SCHEMA_SQL` CREATE targets | 5 static tables, **no** `history_etl_*` |
| Probe `Object.keys(SOURCE_DEFINITIONS)` | 11 keys, set-equal to the README roster |
| `bun test` (deepseek-importer, zstd, rule-engine extensions, runtime index) | 35 pass / 0 fail, 76 expect() calls |
| `spur task check 0061 / 0067 / 0068` | PASS / PASS / PASS (pre-existing baseline warnings only) |
| `spur feature check E / I` | PASS / PASS (feature I: pre-existing 0066 verdict-artifact warnings, unrelated to this patch) |
| `spur task list --feature E --json` vs E roster | equal — 0063 `done`, 0064 `done`, 0068 `wip` |
| `git -C ../spur-new cat-file -e origin/main:<3 C08 paths>` | EXISTS ×3; ADR-112 heading at upstream `00_ADR.md:1621` |
| `git diff --quiet HEAD -- docs/features/INDEX.md` | byte-identical |
| `git status --porcelain` | 13 modified, 0 untracked |

**Next:** let the verify stage record the fresh `bun run spur-check` / `bun run build` evidence, check R1–R10 and fill `### Testing` (finding #1) before the terminal transition; findings #2–#5 are non-blocking advisories the pipeline may carry forward unmodified.

### References

- Audit baseline HEAD: `3d1d074d4d5bd01531c4b16442cf6c78618313db`, 2026-09-16; invoked command: `sp-dev-find-conflict packages --mode full --resolve --agent inline`.
- Original temporary report/envelope were copied into this task's Design evidence; execution must not depend on their survival.
- Process: `docs/99_PROJECT_CONSTITUTION.md` §§2,3,4.3,4.5,5,6.1,6.6,7; project routing: `AGENTS.md`.
- Architecture: `docs/00_ADR.md` ADR-019 and ADR-023 addendum; current topology: `docs/03_ARCHITECTURE.md`.
- Corpus: feature E, feature I, tasks 0060/0061/0064/0066/0067. Query through `spur task show <wbs> --json` and `spur feature show <id> --json`; historical task 0011 explains the superseded absolute-reference design.
- Intentional lazy-materialization change: `22f891f8b88eca7b323a8e02bfc5a1cd354afc79` (2026-08-21).
- External provenance (read-only): Spur `docs/00_ADR.md` ADR-112, `docs/features/A21_reusable-execution-deadlines-and-unlimited-jobs.md`, `docs/tasks4/0734_configurable-scheduler-jobs-interval-real-cron-in-ts-libs-ad.md`. The local sibling path is discovery convenience, not a portable published link.
- Owner skills: sp-spur-cli (task/feature section and lifecycle verbs), sp-doc-evolve (numbered-document authority/projection synchronization), sp-conflict-finding (evidence freshness and claim-specific authority).
- Excluded follow-up U01: 43 historical task records failed the current validator at audit time; not implementation failures and not repair scope for this task.

### History

- 2026-09-16T17:14:24.289Z backlog → todo (system)
- 2026-09-16T17:58:32.475Z todo → wip (system)
- 2026-09-16T20:21:51.408Z wip → testing (system)
- 2026-09-16T20:22:08.671Z testing → done (system)

