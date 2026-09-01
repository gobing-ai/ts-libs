---
schema_version: 1
name: "Retain forensic tool call metadata in ts-llm-jsonl-importer args_raw across all agents and tool types"
status: todo
template: standard
created_at: 2026-08-31T23:47:58.748Z
updated_at: "2026-08-31T23:57:30.673Z"
feature_id: E
---

## 0064. Retain forensic tool call metadata in ts-llm-jsonl-importer args_raw across all agents and tool types

### Background
Follow-up to tasks 0455 and 0553 in the `spur-new` repository. Those tasks added nullable
`history_tool_call.args_raw` for a small todo/shell allowlist while preserving `args_digest` for
loop detection. That allowlist blocks the current `spur-new` Tool Using view and skill rollups from
seeing file paths, searches, URLs, skill names, and coordination metadata.

The affected write paths are the typed `history_tool_call` producers in
`@gobing-ai/ts-llm-jsonl-importer`: Claude, Pi, OMP, Codex, Antigravity CLI (`agy`), Gemini CLI,
Grok, and the OpenCode SQLite importer. Generic `history_etl_*` sources do not emit tool-call rows.

Downstream consumers require two compatible representations:

- Shell tools retain the existing plain command string used for attribution.
- Structured arguments remain valid JSON so SQLite `json_valid` / `json_extract` and the web
  formatter can read skill names and forensic metadata.

The current worktree contains a partial task-0064 draft. It proves the universal-retention seam but
is not the frozen solution: it slices serialized JSON at 8,192 characters (which can create invalid
JSON) and does not recurse into arrays when pruning bulky payloads.
### Requirements
- [ ] R1. Populate `args_raw` whenever invocation arguments exist on every typed tool-call producer:
  Claude, Pi, OMP, Codex, `agy`, Gemini, Grok invocation events, and OpenCode SQLite. Events that
  contain no invocation arguments, such as Grok completion-only rows, remain `NULL`.
- [ ] R2. Recursively sanitize JSON objects and arrays. Preserve forensic metadata (commands, skill
  names/args, paths/ranges, searches, URLs, coordination fields, MCP identifiers, instructions, and
  diagnostics); replace large code/file/buffer/image payload strings with `[omitted N chars]`; and
  truncate other unusually long strings with an explicit original-length marker.
- [ ] R3. Return valid JSON for every JSON object/array/primitive input, including pre-stringified
  Codex arguments. Structured `args_raw` must remain `json_valid(...) = 1` and be at most 8,192
  JavaScript characters; never enforce the ceiling by slicing serialized JSON.
- [ ] R4. Preserve existing shell compatibility: recognized bash/shell/exec/command tools store the
  extracted `command`, `CommandLine`, `cmd`, or `script` value as a plain string, join command arrays
  with spaces, and cap the result at 8,192 characters.
- [ ] R5. Keep the existing persistence redaction seam active in both `runJsonlImport` and
  `runOpenCodeImport`; add a regression proving a default-recognized secret inside newly retained
  generic arguments is redacted before database persistence.
- [ ] R6. Do not change `args_digest` calculation, `history_tool_call` schema/migrations, package
  exports, downstream `spur-new` queries/UI, or release mechanics. This task is additive retention
  inside the importer package only.
- [ ] R7. Keep the implementation local to the existing helper/call sites. No per-source allowlist,
  sanitizer class, new dependency, public API, or generalized serialization framework.

Out of scope: generic `openclaw` / `antigravity` `history_etl_*` rows, unsupported Hermes ingestion,
tool result bodies, consumer UI/query changes, real database re-imports, version bumps, and publish.
### Acceptance Criteria
**AC1 — Typed producer parity**

- **Given** representative tool invocations from Claude, Pi, OMP, Codex, `agy`, Gemini, Grok, and
  OpenCode with non-null arguments,
- **When** each existing mapper/importer path produces `history_tool_call`,
- **Then** `args_raw` contains the sanitized command or structured arguments rather than `NULL`,
  while a completion-only event with no arguments remains `NULL`.

**AC2 — Recursive bulky-payload pruning**

- **Given** a write/edit payload containing a 50 KiB content string inside a nested object or an
  object inside an array, plus a target path and line metadata,
- **When** `maybeArgsRaw` sanitizes it,
- **Then** the content becomes `[omitted 51200 chars]`, the path/range remains queryable, the result
  parses as JSON, and its length is at most 8,192 characters.

**AC3 — Pre-stringified JSON safety**

- **Given** Codex-style `arguments` containing stringified JSON with skill metadata and a large
  replacement payload,
- **When** `maybeArgsRaw` processes it,
- **Then** it parses, sanitizes, and re-serializes the value; the skill name remains available via
  `JSON.parse`, and the replacement payload is omitted.

**AC4 — Hard ceiling without corrupt JSON**

- **Given** structured sanitized arguments whose serialized form still exceeds 8,192 characters,
- **When** the bounded serializer applies its fallback,
- **Then** the output is valid JSON, carries an explicit truncation marker, and has length at most
  8,192; a recognized shell command is instead returned as the existing capped plain string.

**AC5 — Redaction and digest compatibility**

- **Given** a newly retained generic tool argument containing a token matched by the default
  redaction rules,
- **When** it is imported through the JSONL or OpenCode persistence path,
- **Then** the stored `args_raw` contains the redaction marker, no schema changes occur, and existing
  digest assertions remain unchanged.

**AC6 — Repository gates**

- **Given** the implementation and focused regressions,
- **When** the package tests, canonical `bun run spur-check`, and `bun run build` execute,
- **Then** all pass without skips, suppressions, or unrelated changes.
### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-08-31T23:48:33.184Z

- **Q: Why not store entire raw arguments without pruning?**
  A: Tools like `write_to_file` or `replace_file_content` frequently contain entire multi-thousand line files (100KB to 2MB). Storing full file payloads in `history_tool_call` would explode SQLite database sizes, degrade query caches, and duplicate codebase files into the analytics DB. Pruning bulky payload fields (`content`, `code_content`, `replacement_content`) while keeping `target_file` / `path` and `instruction` provides 100% of the forensic value at <1% of the storage cost.

- **Q: How does this affect Q4 loop detection?**
  A: Loop detection continues to query `history_tool_call.args_digest`, which is computed from the unpruned input object. `args_raw` is an additive user-facing and extraction field and does not affect the digest.

- **Q: How does this affect existing databases?**
  A: `history_tool_call.args_raw` is already a nullable column added in migration `0012`. No schema migration or DDL changes are required. Existing databases will seamlessly receive populated values on their next incremental or full import (`spur history import`).

#### Q&A entry — 2026-08-31T23:57:28.963Z

#### Q&A entry — 2026-08-31 ready-depth refinement

- **Q: Which agents are actually covered by “all agents”?**
  A: Every current producer of typed `history_tool_call` rows: Claude, Pi, OMP, Codex, `agy`,
  Gemini, Grok invocation events, and OpenCode SQLite. `openclaw` and the generic `antigravity`
  source currently write `history_etl_*`, not tool rows; Hermes is not a supported source. Those
  are explicit non-goals rather than fictional coverage.

- **Q: May the 8,192-character cap slice serialized JSON?**
  A: No. Normal sanitized values serialize directly. If that still exceeds the ceiling, return a
  small valid JSON object containing `_truncated`, the omitted character count, and a bounded
  serialized preview whose size is reduced until the final `JSON.stringify` result fits. The
  fallback intentionally favors a valid bounded forensic preview over a general-purpose lossless
  JSON compactor.

- **Q: Where does secret redaction happen?**
  A: Keep the existing `redactRecord` calls immediately before hashing/persistence in both importer
  paths. `maybeArgsRaw` owns payload-size sanitization, not a second secret-redaction engine. A
  persistence-level regression locks the composed behavior.

- **Q: Does universal retention change loop detection?**
  A: No. Do not edit `argsDigest`, OpenCode's existing digest expression, digest consumers, or the
  schema. `args_raw` remains additive display/query evidence.

- **Q: Why are the task AC not copied from feature E?**
  A: Feature E is currently an organizational package home with an empty Acceptance Criteria
  section; `spur feature check E --json` is clean. These are task-local executable criteria and do
  not rename or claim a feature scenario.

- **Q: Is release part of implementation?**
  A: No. Releases are operator-run and lockstep across the monorepo. This task stops after repository
  gates; version bump, publish, and consumer re-import/dogfood are separate operations.

- **Q: Is the existing worktree draft accepted as-is?**
  A: No. Preserve useful draft work, but fix invalid-JSON truncation, recursive array sanitization,
  typed-producer coverage tests, and persistence redaction evidence before completion.
### Design
#### Contract

No new public API or schema. Keep the existing internal/exported-for-tests signature:

```ts
maybeArgsRaw(source: string, toolName: string, args: unknown): string | undefined
```

`source` stays for call-site compatibility even though universal retention no longer branches by
source. `undefined`/`null` input returns `undefined`.

#### Algorithm

1. For a recognized bash/shell/exec/command tool, extract `command`, `CommandLine`, `cmd`, or
   `script`; join arrays with spaces and return the plain string capped at 8,192 characters. This
   preserves existing attribution behavior.
2. For string input, attempt `JSON.parse`. A parsed JSON value follows the structured path below;
   an ordinary non-JSON string is returned capped at 8,192 characters.
3. Sanitize structured values recursively through both objects and arrays:
   - Normalize a key for comparison with lowercase alphanumerics (so camel/snake variants share one
     rule).
   - For bulky payload keys (`content`, `codeContent`, `replacementContent`, `targetContent`,
     `fileData`, `buffer`, `blob`, `image`, `imageBase64` and snake-case equivalents), replace a
     string longer than 120 characters with `[omitted N chars]`.
   - Preserve shorter payloads and all JSON primitives. Truncate other strings longer than 1,000
     characters to a 1,000-character prefix plus `[truncated N chars]`.
   - Recurse into array elements; do not pass arrays through unchanged.
4. `JSON.stringify` the sanitized value. If it fits, return it unchanged. If it exceeds 8,192
   characters, return a valid JSON object with `_truncated: true`, `omittedChars`, and `preview` of
   the serialized value. Reduce the preview until stringifying that wrapper is at most 8,192; never
   slice the final JSON text.
5. Leave secret redaction at the existing persistence seam: `redactRecord` in `importer.ts` and
   `opencode-importer.ts`. Leave digest calculation untouched.

#### File targets

- `packages/llm-jsonl-importer/src/mappers.ts` — replace the allowlist behavior with the bounded
  recursive sanitizer; keep all existing mapper call sites. Grok completion-only rows remain null
  because the producer event has no arguments.
- `packages/llm-jsonl-importer/tests/mappers.test.ts` — direct helper tests plus representative
  Claude/Pi/OMP/Codex/AGY/Gemini/Grok invocation-path assertions; cover nested arrays,
  pre-stringified JSON, valid capped JSON, and shell compatibility.
- `packages/llm-jsonl-importer/tests/opencode-importer.test.ts` — prove OpenCode SQLite generic tool
  arguments persist after sanitization.
- `packages/llm-jsonl-importer/tests/importer.test.ts` or the closest existing persistence test —
  prove default secret redaction still applies to newly retained generic `args_raw`.

Do not modify `schema-sql.ts`, migrations, package exports, dependency manifests, downstream
`spur-new`, or release files.

#### Anti-patterns

- No per-source/tool allowlist replacement under a new name.
- No raw `serialized.slice(0, 8192)` for structured values.
- No object-only recursion that skips arrays.
- No duplicate redaction framework inside `maybeArgsRaw`.
- No storage of tool result bodies or wholesale code/file payloads.
- No version bump or publish in the implementation task.

#### Handoff

There are no task dependencies. The consumer contract is read-only evidence in `spur-new`:
`HISTORY_SKILL_NAME_SQL` requires valid JSON for skill tools, and `ToolUsingTab` prefers structured
metadata but already falls back to plain command strings/digests. Consumer changes are not required.
### Plan
- [ ] 1. Reconcile the existing task-0064 draft in `mappers.ts` with R1-R4: recursive arrays,
  pre-stringified JSON primitives/containers, valid bounded JSON fallback, and unchanged shell
  command behavior.
- [ ] 2. Extend `mappers.test.ts` with table-driven helper cases and representative assertions for
  each typed mapper producer; explicitly cover Grok completion-without-args remaining null.
- [ ] 3. Add the smallest OpenCode persistence regression and one persistence-level default-secret
  redaction regression; keep digest assertions unchanged.
- [ ] 4. Run the focused package tests and package lint/typecheck; fix root causes only.
- [ ] 5. Run `bun run spur-check` and `bun run build`; inspect `git status` for only task-scoped
  changes.
- [ ] 6. Record implementation, verification, and review evidence through the normal task pipeline.

Requirement mapping: steps 1-2 cover R1-R4/R7; step 3 covers R5-R6; steps 4-6 cover AC6 and the
handoff evidence. Release, publish, and real consumer database re-import remain out of scope.
### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References
- `packages/llm-jsonl-importer/src/mappers.ts` — typed mapper call sites and `maybeArgsRaw`.
- `packages/llm-jsonl-importer/src/opencode-importer.ts` — OpenCode SQLite tool-call persistence.
- `packages/llm-jsonl-importer/src/importer.ts` and `src/redaction.ts` — existing pre-persistence
  redaction seam.
- `packages/llm-jsonl-importer/src/sources.ts` and `src/types.ts` — supported sources and typed vs
  generic source definitions.
- `packages/llm-jsonl-importer/README.md` — package persistence/redaction contract.
- `docs/00_ADR.md` ADR-001 and `docs/PACKAGE_RELEASE.md` — lockstep, operator-run release policy.
- `spur-new:docs/tasks3/0455_etl-contract-what-is-a-forensic-history-record.md` — original forensic
  ETL contract.
- `spur-new:docs/tasks4/0553_retain-forensic-primitives-at-import-todo-arg-allowlist-and-.md` —
  nullable `args_raw` and allowlist baseline.
- `spur-new:docs/tasks4/0724_history-board-tool-using-orpc-api-contracts-domain-query-and.md` — Tool
  Using consumer contract.
- `spur-new:packages/domain/src/analytics/forensic-query.ts` and
  `packages/domain/src/analytics/history-board-rollup.ts` — `json_valid` / `json_extract` skill
  analytics.
- `spur-new:apps/web/src/modules/history/ToolUsingTab.tsx` — structured-argument display behavior.
- Feature E (`ts-llm-jsonl-importer`); it currently has no feature-level AC scenarios.
### History
