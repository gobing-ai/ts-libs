Done. Doc-evolve wrapup for 0063: audit ran with detection commands (rg across 00–05/design/AGENTS.md → 0 stale claims; ADR tail read → no decision owed; 04 satellite contract defers importer usage to package README, updated same-change). Zero drift, no repairs, no §8 lesson. Task/feature corpus untouched. Learnings written to `.spur/run/wrapup-learnings.md`.

# Wrapup learnings — 2026-08-31

## 2026-08-31 · Task 0063 — Antigravity CLI history.jsonl import (ts-llm-jsonl-importer)

### Conventions

- Importer scan-root facts live in SOURCE_DEFINITIONS (packages/llm-jsonl-importer/src/sources.ts) and the package README only — numbered docs 03/04 deliberately defer usage surface to package READMEs via docs/design/package-exports.md. Zero-drift audit at wrapup confirmed: no key doc ever stated the agy root, so the root change obligated no 00–05 edit (T3 satisfied by the same-change README edit).
- Discriminate record families by a presence check on a field unique to the new family (raw.display !== undefined) instead of enumerating producer type values; pass unknown type through as record_type so future producer types classify without code changes.
- Reuse a sibling mapper's established fallback rather than inventing a new one: seq → context.sourceLine fallback mirrors geminiSplit exactly.
- Presence-check safety must be data-proven before freezing design: display occurs 0 times in a 4,463-record legacy transcript sample while type + step_index appear on every legacy record.

### Errors fixed

- Real bug: SOURCE_DEFINITIONS['agy'].defaultRoots was ['.gemini/antigravity-cli/brain'], one level below ~/.gemini/antigravity-cli/history.jsonl, so the prompt index was never discovered. Fix: single widened root ['.gemini/antigravity-cli'] — walkDir (packages/runtime/src/fs.ts) recurses, so widening supersedes; adding a second root would re-walk the subtree for nothing.
- Earlier premise errors (idea-eval report + first task draft both wrong, all disproven against the tree before design freeze): brain/ does hold 1,174 *.jsonl (not zero); timestampOf already converts numeric ms epochs (no change); AGY_SCHEMA is z.object({}).passthrough() and accepts every field (no change); AGY_FIELD_MAP keys output columns consumed by normalizeRecord and never sees raw — editing it for raw input names would be silently wrong, not just useless.
- History records previously degraded on import: session_id 'unknown' (explicitSessionId ignored conversationId), role/disposition 'unknown' and content_text null (default switch arm), cwd hard-coded null, seq 0 for all 977 records erasing intra-session order.

### Patterns

- walkDir recursion + the found-Set dedupe make a widened single root strictly better than sibling roots; prefer raising the root over listing both.
- Idempotence by construction: recordHash = sha256({source, sourceFile, sourceLine, splitIndex, record}) is line-anchored and history.jsonl is append-only — no new code, only a regression test that would fail if hash inputs stop being line-anchored.
- force-file mode is the correct test lens for hash-dedupe: plain incremental short-circuits unchanged files at the (size, mtimeMs) checkpoint identity check (src/importer.ts:165-176) before reading any line, so "processedLines = lineCount, importedRecords = 0" is unreachable there; force-file skips checkpoints while keeping ledger dedupe.
- Freeze design on verified ground truth, not prior drafts: the task carried an explicit "earlier claim vs ground truth" table and the Design froze on the corrected table; Q&A entries D1–D7 record each dropped/deferred idea with its reason and revisit condition.
- Sample live data before choosing a discriminator or claiming a field's distribution (977 history records, 4,463 transcript records sampled; type distribution: absent 769 / slash_command 204 / shell 4 — a third value existed beyond what the earlier design enumerated).

### Gotchas

- conversationId is absent on 89/977 history records — the first prompt of each conversation, emitted before the id exists. They land session_id 'unknown' by design; forward-filling needs cross-line state the per-record agySplit signature does not carry (deferred, Q&A D5).
- gherkin wording vs mechanism: "incremental mode" in an AC can be literally unsatisfiable when the mode short-circuits before the behavior under test — document the deviation and test via the mode that actually exercises the invariant (force-file), never relax the assertion.
- spur task update has no --name flag: a title/scope conflict (title promised "conversation databases", scope excluded them) is resolved in-task as an explicit non-goal with a pointer to the future task, not by renaming.
- Unconditional seq fallback changes behavior for synthetic legacy records lacking both seq and step_index (source line instead of 0) — harmless on live data (every real transcript record carries step_index) but worth a review note; R4 byte-identity holds only on real shapes.
- A semantics-preserving ?? {} hardening on a pre-existing other-task fixture line (tests/mappers.test.ts, task 0678) inside an in-scope file must be disclosed in the Solution, not slipped in silently.
- Deferred work is split, not appended: conversation .db/.pb import is a new task modelled on src/opencode-importer.ts (~40-line diff stayed ~40 lines); the deferred item records its revisit condition instead of a TODO.

### Doc-evolve wrapup note (2026-08-31)

- Zero-drift audit for 0063 backed by detection commands: rg for antigravity-cli across docs/00–05, docs/design/, AGENTS.md returned 0 hits; 04's satellite contract defers importer usage to the package README, which was updated in the same change. No repair owed; no §8 lesson (nothing systemic about doc maintenance).
