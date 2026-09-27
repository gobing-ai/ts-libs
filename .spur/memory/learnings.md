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
Verification and confidence, per claim:

| Claim | Level | Evidence |
|---|---|---|
| 5 index rows ↔ 5 satellites; 11 packages ↔ 11 export rows after repair | **HIGH** | `rg -o 'design/[a-z0-9-]+\.md' docs/04_DESIGN.md` vs `ls -1 docs/design/`; `ls -1 packages \| wc -l` = 11 vs `rg -c '^\| \`@gobing-ai'` = 11 |
| Frontmatter now current on `00`/`03`/`04` | **HIGH** | `rg -n '^updated_at\|^version'` → 1.4.0/1.5.0/1.5.0, all `2026-09-26` |
| ADR-032's rule-exclusion claim was wrong | **HIGH** | `git diff .spur/rules/typescript/runtime-boundaries.yaml` shows one added line under `no-direct-fs-io` only, in this same change; `launcher.ts:8` imports `node:fs/promises` and no `node:path` |
| `ts-decision-fm` row was never in `package-exports.md` | **HIGH** (upgraded from inference) | `git log -p --follow` over the file → zero `decision-fm` matches; last touch was the 0074–0082 laya batch |
| Lint + rule gate green | **HIGH** | Biome 490 files clean, 11/11 `tsc` exit 0, `spur rule run` → 55/55 passed |
| Test suite unaffected | **HIGH** | `git status --porcelain docs/` — my edits are 4 modified `.md` + 1 new `.md`, zero source files |
| No task/feature corpus written by me | **HIGH** | `docs/features/*` and `docs/tasks/0088*` modifications were already present in the session-start git snapshot; I issued no writes to them |
| The ADR/`03`/satellite ownership split I chose is the right decomposition | **MEDIUM** | Reasoned from constitution §6.0 rule 2, §6.1 rule 2, §6.4 rule 2 — a defensible reading, not a mechanically checkable fact |
| UTC-vs-PST as the cause of the task/ADR date skew | **MEDIUM** | Task `created_at: 2026-09-27T04:10Z` vs ADR `2026-09-26` is consistent with PST −8; I did not confirm the writer's timezone handling |
| `01_PRD.md` has no per-package scope table | **HIGH** | `rg -n '^\|' docs/01_PRD.md` → only the users table; `rg` for package names → no matches |

## 2026-09-26

### Task 0088 — Build reusable Playwright browser profile sessions in ts-browser-automation

#### Conventions

- New workspace package checklist that passed the gate unchanged: lockstep version in the manifest, internal deps as `workspace:*` plus the tsconfig `paths` source closure (ADR-004/012), export map with `.` only, `sideEffects: false`, `tsconfig.build.json`, README, tests under `tests/` (never `src/`).
- Heavy platform dependency pattern: required peer (`playwright@^1.55.0`) plus a pinned devDependency (`1.55.0`) for typecheck and tests; the consumer owns the browser install. Keeps the package installable for consumers that never open a browser.
- A platform-API exception needs three synchronized artifacts, not one: a dated ADR entry, the matching exclusion in `.spur/rules/typescript/runtime-boundaries.yaml`, and one named adapter module. Scope the exception to a single file (`src/launcher.ts`), never to a package.
- Type-only imports of the peer (`import type { BrowserContext } from 'playwright'`) keep public types genuine while the runtime `import('playwright')` stays lazy — no import-time side effect, clear error when the peer is absent.
- Doc-order for a new public surface: satellite `docs/design/<slug>.md` first, then the `04_DESIGN.md` index row, same change (§4.5 rule 5 / T9).

#### Patterns

- One internal launcher seam backing N public operations: `BrowserLauncher` injection let 37 tests cover the full lifecycle and failure taxonomy with zero live browser.
- Caller-owned readiness predicate instead of library-inferred auth. Filesystem state never implies a session; a headless launch against a missing profile fails loudly rather than creating an unauthenticated one.
- Validate cheap preconditions at operation entry, before acquiring the expensive resource — `assertFiniteTimeoutMs` runs before any headed window opens, so a bad timeout cannot park a visible browser in an endless poll.
- Typed error taxonomy over string matching, with remediation in the message: `LoginTimeoutError` carries the re-login instruction, `PlaywrightUnavailableError` carries the install command.
- Adopt existing user data in place; create-with-mode only when absent (`0o700` on creation, never re-permission or move an existing profile dir).

#### Errors fixed (doc drift repaired in this wrapup)

- `04_DESIGN.md` was the one key doc the implementation batch skipped: a new package shipped a full public API (3 operations, 5 option types, 7 error classes) with no `docs/design/` satellite and no index row — a T3/T9 breach. Fixed by adding `docs/design/browser-profile-sessions.md` + its index row.
- `docs/design/package-exports.md` carried 9 rows for 11 packages: `ts-decision-fm` had been missing since the ADR-029/030 batch, so the same omission recurred two batches in a row. Enumerating satellite tables need a count check (`ls packages | wc -l` vs row count), not a visual scan.
- ADR-032 Consequences was factually wrong inside its own commit: it claimed the rule exclusion "lands with the rule gate, not in this package" and named `no-direct-node-path`, while reality was the exclusion landing in the same change, under `no-direct-fs-io` only — and no path exclusion is needed at all because path math routes through `ts-runtime`. Forward-looking prose in an ADR goes stale before the commit lands; state what shipped.
- `00_ADR.md` and `03_ARCHITECTURE.md` bodies were edited while their frontmatter `version`/`updated_at` stayed at `2026-09-20` (§4.3 rule 3). Body edit without frontmatter bump is the default failure mode; bumped to 1.4.0/1.5.0 and `2026-09-26`.
- Mechanism was restated three times: ADR-032's Decision, `03`'s § browser-automation, and the new satellite all carried `0o700`, the lazy import, type-only imports, and the no-side-effect claim (§6.0 rule 2). Split by ownership — ADR keeps decision + one-line reason, `03` keeps enforceable invariants, the satellite keeps shapes.

#### Gotchas

- Timestamp skew between layers: task history is UTC (`2026-09-27T04:10Z`) while ADR entries and doc frontmatter use local PST (`2026-09-26`). A date-based recency audit that does not normalize reads a full day of phantom drift.
- `03_ARCHITECTURE.md` drifts toward shape enumeration whenever a package has no design satellite yet — the shapes have to land somewhere. Creating the satellite is what lets `03` shrink back to boundaries and invariants.
- Invariants in `03` are worth writing as a bullet list of enforceable statements (§6.4 rule 3): each line maps to something a rule or reviewer can check, unlike the prose paragraph it replaced.

#### Verification

- Markdown-only repairs do not need the full suite: `bun run lint` (Biome over 490 files + 11/11 per-package `tsc`) and `spur rule run --preset recommended-pre-check --fail-on warning` (55 rules passed) are sufficient; the 2576-test run is unaffected by doc edits.
- Two commands catch index/satellite drift mechanically and should open any drift audit: `rg -o 'design/[a-z0-9-]+\.md' docs/04_DESIGN.md | sort -u` against `ls -1 docs/design/`, and `ls -1 packages | wc -l` against `rg -c '^\| \`@gobing-ai' docs/design/package-exports.md`.
