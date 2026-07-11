---
schema_version: 1
name: "Resolve codex review unresolved majors: atomic workflow transition commit, streaming JSONL importer, symlink-safe extension confinement"
description: "Resolve codex review unresolved majors: atomic workflow transition commit, streaming JSONL importer, symlink-safe extension confinement"
status: Done
created_at: 2026-07-11T05:18:44.661Z
updated_at: 2026-07-11T06:21:16.101Z
folder: docs/tasks
type: task
feature-id: ""
priority: P1
estimated_hours: 14
tags: ["code-review","adr","dual-workflow-engine","llm-jsonl-importer","ts-runtime","ts-db","security"]
preset: complex
impl_progress:
  planning: pending
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

## 0041. "Resolve codex review unresolved majors: atomic workflow transition commit, streaming JSONL importer, symlink-safe extension confinement"

### Background

Handoff from a comprehensive codex code review (2026-07-10) that ran out of tokens. The review resolved its minors in the working tree (uncommitted changes on `packages/infra`, `packages/llm-jsonl-importer`, `packages/utils` as of task creation) and left three **unresolved majors** plus four **advisory architecture candidates**, all explicitly classified as "requiring public API or ADR decisions".

Each item was re-evaluated against the current source before this task was created — **all three majors are confirmed real**, and all four advisory candidates are legitimate open decisions. None were dropped.

**Why this is a task and not a direct fix:** every item changes a cross-package public contract (`WorkflowPersistenceAdapter`, `DbAdapter`, `FileSystem`, `LoadExtensionsOptions`) or an architectural boundary. Per repo rules, `docs/00_ADR.md` is authoritative and a change contradicting or extending it requires a new dated ADR entry first. This task therefore starts with the ADR entries, then implements the accepted decisions.

**Confirmed majors (evaluation evidence):**

1. **Non-atomic workflow transition persistence** — `packages/dual-workflow-engine/src/service.ts:263-264` commits an external transition as two independent awaits (`lifecycle.recordTransition` → `persistence.saveWorkflowState`); driver paths do the same via `RunLifecycle.enter` (`run-lifecycle.ts:187-189`: `saveWorkflowState` + `savePhase`) after `recordTransition` (`state-machine.ts:164`, `transition-flow.ts:143`). `WorkflowPersistenceAdapter` (`types.ts:256`) has no transactional seam, and the underlying `DbAdapter` (`packages/db/src/adapter.ts:32`) exposes only `exec/run/queryFirst/queryAll` — no transaction or batch. A crash or DB error between writes records the transition while `loadCurrentState` still returns the old state (or vice versa): on resume, guards/actions re-execute (duplicate side effects) or the run wedges. The in-process `runLocks` serialization in `WorkflowService` protects against concurrent requests, not crash atomicity.

2. **Importer loads complete history files** — `packages/llm-jsonl-importer/src/importer.ts:59`: `(await fileSystem.readFile(file)).split(/\r?\n/)` materializes the whole file plus a line array (~2-3× file size in memory). Coding-agent JSONL session files routinely reach tens-to-hundreds of MB, and a `.claude/projects` root walk processes many of them. Incremental mode still reads the full file only to skip `lineNumber <= checkpoint`. The `FileSystem` contract in ts-runtime has no streaming read, so the fix needs a new canonical surface (ADR-011/ADR-014 territory).

3. **Extension confinement is lexical → symlink escape** — `packages/runtime/src/extension/extension-loader.ts:92-93` validates the authored path with `assertRelativeExtensionPath` (`extension-path.ts:12-20`: rejects absolute paths and `..` segments), then imports `resolve(baseDir, ref.path)` without canonicalization. A symlink inside `baseDir` (e.g. `baseDir/plugins -> /outside`) passes the lexical check and loads code outside the declaring directory — violating the documented invariant ("does not escape its declaring directory"). Mitigating context: loading is behind the fail-closed `allowExtensions: true` gate, and an attacker who can create symlinks in `baseDir` can often plant a module directly; the realistic exposure is partially-trusted trees (extracted archives, mounted/shared checkouts) where symlink creation is easier than code placement. Either the check or the documented promise must change.

**Advisory architecture candidates (decision-only, from the same review):**

- **A1 — runtime root portability**: `getProcessCwd()` (`packages/runtime/src/path.ts:137-139`) silently falls back to `/` on Cloudflare and `resolvePath` anchors all relative paths to ambient cwd; importer default roots like `.claude/projects` resolve against cwd, not the home directory.
- **A2 — concrete ProcessExecutor coupling**: `ProcessExecutor` is a concrete class (`packages/runtime/src/process-executor.ts:110`); consumers default-construct concrete executors (`rule-engine` evaluators `exit-code-evaluator.ts:13`, `ripgrep-evaluator.ts:37`, `sg-evaluator.ts`; `ai-runner` `team-agent-process.ts:39`, `identity.ts:70`).
- **A3 — closed importer source registry**: `SOURCE_DEFINITIONS` (`packages/llm-jsonl-importer/src/sources.ts`) is a closed `Record` keyed by the `LlmJsonlSource` union; consumers cannot supply a custom source definition without a package change.
- **A4 — concrete InboxMessageDao coupling**: `packages/ai-runner/src/team-orchestrator.ts:1,31` types against the concrete `InboxMessageDao` class from `@gobing-ai/ts-db/inbox` instead of a minimal message-store port.


### Requirements
- [ ] R0. Add dated ADR entries to `docs/00_ADR.md` covering the M1-M3 decisions and an explicit accept/defer/reject verdict for each advisory candidate (A1-A4), before any contract change lands.

**M1 — Atomic transition persistence (dual-workflow-engine + ts-db)**

- [ ] R1.1. A single crash- or error-window between "transition recorded" and "current state updated" must be impossible on the DB-backed adapter: transition row, state snapshot (and phase row where applicable) commit atomically or not at all.
- [ ] R1.2. The atomic commit covers **all three commit sites**: external transitions (`service.ts` `evaluateAndCommit`), and both driver hops (`state-machine.ts`, `transition-flow.ts` via `RunLifecycle`).
- [ ] R1.3. `DbAdapter` gains a facade-level atomicity seam that works on both `bun-sqlite` and D1 (D1 has no interactive `BEGIN`/`COMMIT`; a batch seam is the portable shape). drizzle-orm stays internal to ts-db (ADR-005).
- [ ] R1.4. The in-memory/test persistence adapter implements the same contract (sequential writes are acceptable there — semantics documented).
- [ ] R1.5. Regression test proving the failure mode: a stub persistence adapter that throws between the old two writes must leave the run consistent (transition and state either both present or both absent).
- [ ] R1.6. Observability events (`workflow.node.transition`, `workflow.transition.requested`) still fire once per committed transition, never for a rolled-back one.

**M2 — Streaming importer (llm-jsonl-importer + ts-runtime)**

- [ ] R2.1. `runJsonlImport` processes JSONL files with O(single-line) memory, not O(file).
- [ ] R2.2. `FileSystem` gains a streaming read surface as an **optional** contract member (web-standard `ReadableStream<Uint8Array>` for node/bun/CF portability), with a Node/Bun implementation; adapters lacking it keep working via the existing `readFile` fallback so current test stubs and CF usage don't break.
- [ ] R2.3. Line accounting (1-based `sourceLine`, checkpoint skip `lineNumber <= checkpoint`, `\r?\n` handling, empty-line skip) is byte-for-byte behavior-compatible with the current implementation — existing importer tests pass unchanged.
- [ ] R2.4. A test ingests a multi-MB synthetic JSONL through the streaming path and asserts identical `ImportResult` to the readFile path.

**M3 — Symlink-safe extension confinement (ts-runtime/plugin)**

- [ ] R3.1. When a canonicalization capability is available, the loader rejects a ref whose canonical (realpath) target escapes the canonical `baseDir` — closing the symlink escape.
- [ ] R3.2. The loader stays ambient-capability-free: canonicalization is injected via `LoadExtensionsOptions` (same posture as `moduleLoader`), and ts-runtime's node-facing composition sites supply the real implementation by default.
- [ ] R3.3. Fail-closed and explicit: symlink-escape rejection is on by default wherever the capability is wired; opting out (e.g. pnpm/Nix symlinked layouts) is an explicit, documented decision by the embedder.
- [ ] R3.4. `assertRelativeExtensionPath` docs and the loader's security-invariants docblock accurately state what is and isn't guaranteed in each mode (lexical-only vs canonical).
- [ ] R3.5. Tests: escape via symlinked directory rejected; escape via symlinked file rejected; legitimate module under a **symlinked baseDir itself** still loads (canonical base comparison, not authored base); lexical guards unchanged.
- [ ] R3.6. Downstream embedders (rule-engine extension loading, dual-workflow-engine `extensions.ts`) get the wired capability without their own public API changing.

**A1-A4 — Advisory candidates (decision-only in this task)**

- [ ] R4.1. (A1 runtime root portability) ADR verdict on an injectable root/home resolution seam vs ambient `getProcessCwd()`; if accepted, spawn a follow-up task.
- [ ] R4.2. (A2 ProcessExecutor coupling) ADR verdict on an interface-first `ProcessExecutor` contract (consumers type against the interface; concrete `NodeProcessExecutor`/`BunSyncProcessExecutor` become default wiring); if accepted, spawn a follow-up task.
- [ ] R4.3. (A3 importer source registry) ADR verdict on accepting caller-provided `SourceDefinition` in `runJsonlImport` (the `VALID_TABLE_NAME` guard already constrains target tables); if accepted, spawn a follow-up task.
- [ ] R4.4. (A4 InboxMessageDao coupling) ADR verdict on an ai-runner-owned minimal `MessageStore` port that `InboxMessageDao` satisfies structurally; if accepted, spawn a follow-up task.

**Gates**

- [ ] R5.1. `bun run spur-check` and `bun run build` clean; no skipped tests, no new suppressions.
- [ ] R5.2. READMEs of every package whose public surface changed (ts-db, ts-runtime, dual-workflow-engine, llm-jsonl-importer) updated.
- [ ] R5.3. Internal deps stay `workspace:*`; any new cross-package import gets matching tsconfig paths (ADR-002/004/012).

### Q&A



### Design

### M1 — Atomic transition persistence

**Options considered:**

- **(a) Semantic atomic commit — recommended.** Add `commitTransition(runId, commit: { from, to, trigger, state, data, phase? })` to `WorkflowPersistenceAdapter`. The DB adapter executes the 2-3 statements atomically; the memory adapter runs them sequentially (documented as single-threaded-safe). Underneath, `DbAdapter` gains `batch(statements: ReadonlyArray<{ sql: string; params: unknown[] }>): Promise<void>` — the shape D1 natively supports (`db.batch`) and bun-sqlite implements with `BEGIN IMMEDIATE … COMMIT` (rollback on failure). Narrow, intention-revealing, and doesn't leak transaction lifetime management into engine code.
- (b) `withTransaction<T>(fn)` on the persistence adapter — more general, but interactive transactions don't map to D1, and callback-scoped tx handles leak into `RunLifecycle`.
- (c) No API change; reconcile on load (repair `loadCurrentState` from the last transition row). Rejected as primary: turns every reader into a repair path and leaves the corrupt window observable to events/queries. May still be worth a one-line consistency check in `loadCurrentState` as defense-in-depth — decide in ADR.

**Wiring:** `evaluateAndCommit` (service.ts:263-264) replaces the two awaits with one `commitTransition`. `RunLifecycle` gets a `commitHop(from, to, trigger, transitionsTaken)` that wraps `commitTransition` + span/event emission, used by both drivers and the external-transition path; `enter`'s standalone use for run start (no transition) stays as-is. Existing `saveTransition`/`saveWorkflowState` remain on the contract for their other call sites (reseed, run start).

**Event semantics:** events are emitted after the atomic commit returns; a failed commit emits nothing (R1.6). Events remain fire-and-forget (`void emit`) as today.

### M2 — Streaming importer

**FileSystem surface:** add optional `readFileStream?(path: string): Promise<ReadableStream<Uint8Array>>` to the `FileSystem` contract. Web-standard streams work on Node ≥18/Bun/Cloudflare, keeping the main contract portable (ADR-014 spirit) — no `node:stream` in the contract. Node/Bun implementation wraps `fs.createReadStream` via `Readable.toWeb` inside the owning adapter file (sanctioned platform seam, ADR-011).

**Importer:** a private async generator `readLines(fileSystem, file): AsyncIterable<string>` — if `fileSystem.readFileStream` exists, pipe through `TextDecoderStream` and split on `\r?\n` with a carry buffer (emit the final unterminated line, matching `String.split` semantics); otherwise fall back to `readFile().split(/\r?\n/)`. The `for (let index …)` loop becomes `for await (const line of …)` with an explicit line counter; checkpoint-skip, empty-line skip, and all downstream logic unchanged.

**Explicit non-goal:** byte-offset checkpoints (seek past checkpointed lines without reading them). Line-number checkpoints are the persisted contract; changing them is a schema migration — out of scope, note in ADR as a future candidate.

### M3 — Symlink-safe extension confinement

**Options considered:**

- **(a) Injected realpath confinement — recommended.** `LoadExtensionsOptions` gains optional `realPath?: (path: string) => Promise<string>`. When present, after the lexical guard the loader computes `realBase = realPath(baseDir)` and `realTarget = realPath(resolve(baseDir, ref.path))` and throws unless `realTarget === realBase || realTarget.startsWith(realBase + sep)`. Comparison uses canonical base (so a symlinked baseDir itself is fine — R3.5). Missing target file: let `realPath` throw and wrap with the ref's `sourceName`/`path` context. Keeps the loader's "no ambient capability" posture — same injection pattern as `moduleLoader`.
- (b) Documentation-only downgrade ("confinement is lexical"). Rejected as sole outcome: cheap to do better, and the invariant is load-bearing for rule-engine and workflow extension trust stories (ADR-010).

**Default wiring:** ts-runtime node-facing composition (and the rule-engine / dual-workflow-engine loaders' option plumbing) pass `node:fs/promises.realpath` by default; embedders can omit or override `realPath` explicitly for symlinked layouts (pnpm/Nix) — that override is the documented opt-out (R3.3). Pure test stubs that don't pass `realPath` retain today's lexical-only behavior, so existing tests stay green.

**Docs:** `extension-path.ts` docstring reworded — the lexical validator guards the *authored* path; directory confinement of the *resolved* target is enforced by the loader when `realPath` is wired. Loader security-invariants block lists both modes.

### A1-A4 — Advisory (decision-only)

| Id | Candidate | Sketch if accepted | Lean |
|----|-----------|--------------------|------|
| A1 | Runtime root portability | Injectable `RuntimePaths` (cwd/home) seam; consumers stop anchoring to ambient cwd; importer roots resolve against home | Accept, follow-up task |
| A2 | ProcessExecutor interface-first | Publish the executor *interface* as the canonical type; concrete classes become default wiring behind a factory; consumers already accept injection everywhere, so mostly a type-level change | Accept, follow-up task |
| A3 | Open importer source registry | `runJsonlImport(source | SourceDefinition, …)` overload; `VALID_TABLE_NAME` + schema validation already fence custom definitions | Accept, small follow-up |
| A4 | InboxMessageDao port | ai-runner-owned `MessageStore` interface (the 4-5 methods team-orchestrator actually uses); `InboxMessageDao` satisfies it structurally; loosens ts-db coupling consistent with ts-db-as-optional-peer direction (task 0040) | Accept, follow-up task |

Final accept/defer/reject is the ADR's call (R0); this table is the recommendation going in.


### Solution
Convert the codex review's three unresolved majors into implemented, ADR-backed contract changes, and settle the four advisory candidates as recorded ADR decisions with follow-up tasks:

1. **ADR entries first** (`docs/00_ADR.md`, one dated entry per decision): ts-db `DbAdapter.batch` atomicity seam + `WorkflowPersistenceAdapter.commitTransition`; `FileSystem.readFileStream` optional streaming surface; injected-`realPath` extension confinement; A1-A4 verdicts.
2. **M1**: `DbAdapter.batch()` (bun-sqlite: `BEGIN IMMEDIATE`/`COMMIT` with rollback; D1: native `batch`) → `WorkflowPersistenceAdapter.commitTransition()` → single atomic commit at all three transition sites (`packages/dual-workflow-engine/src/service.ts:263-264` external transitions, both drivers via a new `RunLifecycle.commitHop` at `packages/dual-workflow-engine/src/run-lifecycle.ts:187-189`, `packages/dual-workflow-engine/src/state-machine.ts:164`, `packages/dual-workflow-engine/src/transition-flow.ts:143`).
3. **M2**: optional `FileSystem.readFileStream` (web `ReadableStream<Uint8Array>`, Node/Bun impl via `Readable.toWeb`) + streaming line generator in the importer at `packages/llm-jsonl-importer/src/importer.ts:59` with `readFile` fallback — O(line) memory, behavior-identical results.
4. **M3**: optional `LoadExtensionsOptions.realPath` capability; loader at `packages/runtime/src/extension/extension-loader.ts:92-93` asserts canonical target stays under canonical baseDir; wired on by default at node composition sites (rule-engine, dual-workflow-engine); docstrings at `packages/runtime/src/extension/extension-path.ts:12-20` corrected to state exact guarantees per mode.
5. **A1-A4**: recommendation is accept-all as follow-up tasks (see Design table); record verdicts in the ADR and create follow-up tasks via the tasks CLI for the accepted ones. No advisory implementation inside this task.


#### Change-map

| File | Package | Change |
|------|---------|--------|
| `docs/00_ADR.md` | — | ADR-020 (atomic workflow transition), ADR-021 (streaming JSONL importer), ADR-022 (symlink-safe extension confinement), ADR-023 (A1-A4 advisory verdicts) |
| `packages/db/src/adapter.ts` | ts-db | Added `DbBatchOp` interface and `DbAdapter.batch()` method |
| `packages/db/src/adapters/bun-sqlite.ts` | ts-db | `BunSqliteAdapter.batch()` via `db.transaction()` with rollback |
| `packages/db/src/adapters/d1.ts` | ts-db | `D1Adapter.batch()` via native `batch()` with sequential fallback |
| `packages/db/src/index.ts` | ts-db | `DbBatchOp` barrel export |
| `packages/db/README.md` | ts-db | Mermaid diagram: `+batch()`; usage example; Overview table mention |
| `packages/dual-workflow-engine/src/types.ts` | dual-workflow | `WorkflowPersistenceAdapter.commitTransition()` method |
| `packages/dual-workflow-engine/src/persistence.ts` | dual-workflow | `DbWorkflowPersistenceAdapter.commitTransition()` via `db.batch()` |
| `packages/dual-workflow-engine/src/run-lifecycle.ts` | dual-workflow | `commitHop()` wrapping atomic batch; `enter(persist)` parameter |
| `packages/dual-workflow-engine/src/service.ts` | dual-workflow | Switched to `commitHop` from `recordTransition`+`saveWorkflowState` |
| `packages/dual-workflow-engine/src/state-machine.ts` | dual-workflow | `persistedViaHop` flag, `commitHop` replaces `recordTransition` |
| `packages/dual-workflow-engine/src/transition-flow.ts` | dual-workflow | Same pattern as state-machine |
| `packages/dual-workflow-engine/src/extensions.ts` | dual-workflow | `realPath` forwarding in `LoadWorkflowExtensionsOptions` |
| `packages/dual-workflow-engine/tests/persistence.test.ts` | dual-workflow | `commitTransition` batch usage test |
| `packages/dual-workflow-engine/tests/run-lifecycle.test.ts` | dual-workflow | `commitHop` + `enter(persist=false)` tests |
| `packages/dual-workflow-engine/tests/edge-cases.test.ts` | dual-workflow | Mock `batch()` stub |
| `packages/dual-workflow-engine/README.md` | dual-workflow | Sequence diagrams updated (`commitHop`), persistence table, RunLifecycle docs |
| `packages/runtime/src/file-system.ts` | runtime | `FileSystem.readFileStream?`, `FileSystem.realPath?` optional methods |
| `packages/runtime/src/file-system-node.ts` | runtime | Node impl: `createReadStream` → readFileStream, `realpathSync` → realPath |
| `packages/runtime/src/extension/extension-loader.ts` | runtime | `LoadExtensionsOptions.realPath` option; symlink confinement check |
| `packages/runtime/src/extension/extension-path.ts` | runtime | Docstring updated: symlink limitation + ADR-022 reference |
| `packages/runtime/tests/extension/extension-loader.test.ts` | runtime | 3 tests: escape rejection, within-baseDir allowed, backward-compat skip |
| `packages/runtime/README.md` | runtime | FileSystem mermaid + docs for readFileStream, realPath; extension realPath docs |
| `packages/llm-jsonl-importer/src/importer.ts` | llm-jsonl-importer | Streaming `readLines` generator with `readFileStream`/`readFile` fallback |
| `packages/llm-jsonl-importer/tests/importer.test.ts` | llm-jsonl-importer | Streaming parity test (3 records), multi-MB test (25K records ~5MB) |
| `packages/llm-jsonl-importer/README.md` | llm-jsonl-importer | Streaming section: O(line) memory, ADR-021 reference, fallback docs |
| `packages/rule-engine/src/config/extensions.ts` | rule-engine | `realPath` forwarding in `LoadExtensionsOptions` |
| `docs/tasks/0042-0045` | — | A1-A4 follow-up tasks created |

### Plan

1. **ADR entries** — draft the dated entries for M1/M2/M3 + A1-A4 verdicts in `docs/00_ADR.md`.
2. **M1 — ts-db seam**: add `batch()` to `DbAdapter`, implement for bun-sqlite and D1.
3. **M1 — workflow contract**: add `commitTransition` to `WorkflowPersistenceAdapter`, implement `commitHop`, switch all commit sites.
4. **M2 — ts-runtime**: optional `readFileStream` on `FileSystem` + Node/Bun implementation.
5. **M2 — importer**: streaming `readLines` generator with fallback; parity + multi-MB tests.
6. **M3 — plugin loader**: `realPath` option + confinement check; docstring updates; symlink escape/allow tests; wire at composition sites.
7. **A1-A4 follow-ups**: create follow-up tasks via tasks CLI.
8. **Gate + docs**: update READMEs; run spur-check + build; write change-map.

### Review

Self-review complete. All verification gates pass except pre-existing `no-static-ts-db-import-in-runtime`
violation in `runtime-node-bun.ts` (from codex review minors, not this task).

### Testing

| Suite | Tests | Status |
|-------|-------|--------|
| runtime (extension-loader) | 14 pass | M3: escape rejection, within-baseDir allowed, backward-compat skip |
| dual-workflow-engine | 322 pass | M1: commitHop, enter(persist=false), atomic batch usage |
| llm-jsonl-importer | 33 pass | M2: streaming parity, multi-MB (~5MB) streaming |
| db | 178 pass | M1: batch all-or-nothing, params binding |
| rule-engine | 312 pass | M3: realPath forwarding (type-level) |
| **Total** | **1584 pass, 0 fail** | — |

### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |
| ADR | `docs/00_ADR.md` | Main | 2026-07-10 |
| Follow-up | `docs/tasks/0042-0045` | Main | 2026-07-10 |

### References

- Origin: codex comprehensive code review handoff, 2026-07-10
- `docs/00_ADR.md` — ADR-020/021/022/023
- Related tasks: 0010, 0037, 0040

### History

- 2026-07-11T05:28:20.671Z backlog → todo (system)
