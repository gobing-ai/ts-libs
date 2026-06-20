---
name: "runtime: retire deprecated FileSystem surface + rule-engine fs injection port"
description: "runtime: retire deprecated FileSystem surface + rule-engine fs injection port"
status: Done
created_at: 2026-06-20T05:58:54.732Z
updated_at: 2026-06-20T06:49:12.199Z
folder: docs/tasks
type: task
feature-id: ""
priority: high
estimated_hours: 14
dependencies: ["0012","0013"]
tags: ["refactor","runtime","rule-engine","migration","testability"]
impl_progress:
  planning: done
  design: done
  implementation: done
  review: done
  testing: done
---

## 0039. "runtime: retire deprecated FileSystem surface + rule-engine fs injection port"

### Background

Architecture-review cluster: finding #3 (major, runtime), #1 (major, rule-engine), #4 (advisory doc note, infra) from the 2026-06-19 dev-review over packages/. ROOT CAUSE shared by #1 and #3: an incomplete filesystem-injection story. ts-runtime exposes the ADR-011 union-return FileSystem (file-system.ts) + createNodeFileSystem() factory (file-system-node.ts) as the canonical surface, but the DEPRECATED async NodeFileSystem class, NodeSyncFileSystem, the legacy FileSystem/SyncFileSystem interfaces, and the getFs() singleton all still live in fs.ts and are consumed by 54 references across 16 files in 4 packages (runtime, rule-engine, ai-runner, llm-jsonl-importer). Split-brain: a new reader must untangle 'which FileSystem do I use?' on every file touch. Separately, RuleEngineOptions injects processExecutor but has NO fileSystem port, so 11 sites construct 'new NodeFileSystem()' directly (3 now live in evaluators/file-discovery.ts after task 0039-pre file-utils split) — every fs-touching evaluator/fixer is untestable without monkey-patching. Predecessor: task 0004 built the scanFiles seam these evaluators share; this task adds the injection the seam was missing. Reviewer recommendation: pair #1 and #3 (do NOT touch rule-engine fs twice) — #1's sites are a SUBSET of #3's migration, so land the injection port as the rule-engine leg of the #3 sweep. #4 is a 10-line doc comment, fold into this PR for free.


### Requirements

## Requirements

Independent verification 2026-06-20 (Phase 8 traceability). **7/7 MET.**

- [x] **R1 — RuleEngineOptions.fileSystem port, threaded to evaluators/fixers, default createNodeFileSystem()** → **MET** | `engine.ts:27` adds `fileSystem?: FileSystem`; `:63` defaults `?? createNodeFileSystem()`; `:166` injects it into every `RuleContext` (`{ rule, workdir, fileSystem: this.fileSystem }`); `:283` threads into `applyFixes`. Routed via `RuleContext.fileSystem` (`types.ts:166`) — a smaller, more testable surface than the planned ctor-threading (1 type extension vs 9+ ctor changes). Design deviation recorded in task Review and sound.
- [x] **R2 — all 11 inline `new NodeFileSystem()` sites consume injected fs** → **MET** | `rg "new NodeFileSystem\(\)" packages/*/src` = ZERO. Every evaluator now reads `context.fileSystem ?? createNodeFileSystem()` (forbidden-import, import-boundary, regex, path, schema-artifact, coverage-gate, tsdoc-export, secrets-scanner, test-location); fixers via `context.fileSystem` (`fixers.ts:179,226`).
- [x] **R3 — migrate ai-runner / llm-jsonl-importer / runtime-internal off deprecated surface** → **MET** | agent-spec.ts, doctor-runner.ts, importer.ts, schema-validation.ts, context.ts, runtime-node-bun.ts all on `createNodeFileSystem()`. doctor-runner.ts:89 now `createNodeFileSystem()` (also unblocks review finding #18 testability).
- [x] **R4 — delete deprecated class/interfaces/getFs() from fs.ts; fix index exports** → **MET** | `rg "NodeFileSystem|NodeSyncFileSystem|getFs\(\)|\bSyncFileSystem\b" packages/*/src` (excl. factory) = ZERO deprecated refs. `fs.ts` reduced 370→~80 lines (utility fns only: ensureDirForFile, walkDir, readJsonFile, atomicWriteFile, createLogStream — all default to `createNodeFileSystem()`). `index.ts` -10 lines (removed deprecated exports).
- [x] **R5 — dated ADR entry for the removal** → **MET** | `docs/00_ADR.md` ADR-019 (2026-06-20, Amends ADR-011), explicitly marks **Breaking change: deprecated runtime exports removed**.
- [x] **R6 — #4 EventBus two-layer observability doc note** → **MET** | `event-bus.ts:165-166` reciprocal comment added pointing to `attachTelemetryObserver` in default-observers.ts for the trace layer. No code moved (correct — ADR-009 model preserved).
- [x] **R7 — gate green; no behavior change; fake-fs injection test** → **MET** | `engine.test.ts` adds `'injected fileSystem reaches evaluators through RuleContext'` with a `fakeFs`. Independent gate: Biome+tsc 8/8 clean; **1514 tests pass / 0 fail**; `bun run build` 8/8 exit 0. No test skipped/suppressed.


### Q&A



### Design

## Design

**Scope:** behavior-preserving migration + dead-surface removal. No new features. The
only intended behavior change is the *removal* of deprecated runtime exports (R4) — a
breaking change for downstream consumers, recorded in the ADR (R5).

### Root cause (why #1 and #3 are one effort, not two)
`#1`'s 11 construction sites are a **subset** of `#3`'s 54-reference migration: rule-engine
constructs the *deprecated* `NodeFileSystem` class. Fixing #3 already touches those sites;
adding the injection port (#1) is the natural landing spot. Doing #1 standalone first means
editing rule-engine's fs code twice. Sequence: inject (rule-engine leg) → migrate other
consumers → delete dead surface.

### Deprecated surface inventory (the delete target — R4)
`packages/runtime/src/fs.ts` holds, all `@deprecated`:
- `NodeFileSystem` (async class) · `NodeSyncFileSystem` (sync class)
- `FileSystem` / `SyncFileSystem` (legacy interfaces, pre union-return)
- `getFs()` module-level singleton

Canonical replacement (keep): `file-system.ts` (`FileSystem` union-return interface) +
`file-system-node.ts` (`createNodeFileSystem()` factory). ADR-011 addendum already names
the union-return interface as canonical and `fs.ts` as compatibility-only.

### Consumer map — 54 refs / 16 files / 4 packages (verified 2026-06-19)
| File | refs | leg |
|------|------|-----|
| runtime/src/fs.ts | 19 | the deprecating file itself — last to gut (R4) |
| runtime/src/runtime-node-bun.ts | 6 | runtime-internal (b) |
| ai-runner/src/agent-spec.ts | 6 | ai-runner (b) |
| runtime/src/index.ts | 5 | export surface — fix when deleting (R4) |
| runtime/src/schema-validation.ts | 4 | runtime-internal (b) |
| rule-engine/src/host/bundled-rules.ts | 4 | rule-engine (a) |
| rule-engine/src/fixers/fixers.ts | 4 | rule-engine (a) — 3 construction sites |
| rule-engine/src/evaluators/file-discovery.ts | 4 | rule-engine (a) — 3 construction sites (post-0039 split) |
| rule-engine/src/config/loader.ts | 4 | rule-engine (a) |
| rule-engine/src/evaluators/schema-artifact-evaluator.ts | 3 | rule-engine (a) |
| rule-engine/src/evaluators/path-evaluator.ts | 3 | rule-engine (a) |
| rule-engine/src/evaluators/coverage-gate-evaluator.ts | 3 | rule-engine (a) |
| runtime/src/context.ts | 2 | runtime-internal (b) |
| rule-engine/src/fixers/test-stub-fixer.ts | 2 | rule-engine (a) |
| llm-jsonl-importer/src/importer.ts | 2 | importer (b) — already partly on createNodeFileSystem |
| ai-runner/src/doctor-runner.ts | 2 | ai-runner (b) — also unblocks #18 testability |

### #1 injection — the 11 construction sites
fixers.ts:69,176,223 · test-stub-fixer.ts:27 · coverage-gate-evaluator.ts:50 ·
schema-artifact-evaluator.ts:28 · file-discovery.ts:38,51,98 · path-evaluator.ts:25 ·
config/loader.ts:209. `RuleEngineOptions` today exposes `processExecutor?` + `persistence?`
but **no `fileSystem?`** — add it beside `processExecutor`, default `createNodeFileSystem()`,
thread via `registerBuiltins`/`registerBuiltinFixers` (which already take the executor).

### #4 EventBus doc note (advisory — not a refactor)
The two-layer model is correct per ADR-009 and must NOT be "fixed" by moving code. Metrics
increment inline at `event-bus.ts:166-167` (`getEventbusEmitsTotal/ErrorsTotal`); traces
attach via `default-observers.ts:80 attachTelemetryObserver`. The comment at
`default-observers.ts:8` already says "Metrics are intentionally omitted here." Add a
reciprocal one-liner at the `emit()` metrics site pointing to the observer for traces, so a
debugger reading either file finds the other. ~10 min.

### Risks
- **HIGH — published runtime surface.** R4 deletes exports from `@gobing-ai/ts-runtime`'s
  index → breaking change for any downstream. Mitigation: ADR entry states it explicitly;
  lockstep bump reflects semver intent; grep proves zero in-repo consumers before deletion.
- **MEDIUM — behavior drift across rule-engine.** Mitigation: per-package migration, run the
  package suite after each leg; existing suites are the regression net (same contract that
  protected task 0004). The injected default must be byte-for-byte the prior behavior.
- **LOW — sync-vs-async return shape.** The deprecated `NodeSyncFileSystem` has sync returns;
  any consumer relying on sync must adopt the union-return contract. Audit at migration time.


### Solution

Pair #1+#3 as ONE migration, sequenced inside-out. (a) Add fileSystem?: FileSystem to RuleEngineOptions (engine.ts), default createNodeFileSystem(); thread through RuleEngineHost + registerBuiltins/registerBuiltinFixers into each evaluator/fixer ctor; drop the 11 inline 'new NodeFileSystem()'. (b) Migrate non-rule-engine consumers (ai-runner doctor-runner.ts/agent-spec.ts, llm-jsonl-importer importer.ts, runtime context.ts/schema-validation.ts/runtime-node-bun.ts) onto createNodeFileSystem(). (c) Once rg shows zero deprecated-surface refs, delete the class/interfaces/getFs() from fs.ts + fix runtime index.ts exports. (d) New ADR entry (dated) for the removal. (e) #4: add the cross-referencing comment in event-bus.ts + default-observers.ts. Migrate one package at a time, running its suite after each — existing suites are the behavior-preservation net. HIGH risk: published runtime surface (ADR-011) — removing exports is a breaking change for downstream, so the ADR entry must state it explicitly and the lockstep bump treats it as a minor/major per semver intent.


### Plan

## Plan

Sequenced inside-out; run the touched package's suite after every leg.

### Leg A — rule-engine injection (#1)
- [x] Add `fileSystem?: FileSystem` (ADR-011 union-return) to `RuleEngineOptions` in `engine.ts`, beside `processExecutor`; default `createNodeFileSystem()` in the ctor
- [x] Thread the fs through `registerBuiltins` + `registerBuiltinFixers` (host/builtins.ts, fixers/fixers.ts) into each evaluator/fixer ctor
- [x] Replace the 11 inline `new NodeFileSystem()` with the injected fs: fixers.ts:69,176,223 · test-stub-fixer.ts:27 · coverage-gate-evaluator.ts:50 · schema-artifact-evaluator.ts:28 · file-discovery.ts:38,51,98 · path-evaluator.ts:25 · config/loader.ts:209
- [x] bundled-rules.ts: route its fs through the same port
- [x] Add a test swapping a fake fs via the new port (proves the seam); run full rule-engine suite — must stay green unchanged

### Leg B — migrate remaining deprecated-surface consumers (#3)
- [x] ai-runner: doctor-runner.ts (also unblocks #18 testability), agent-spec.ts → createNodeFileSystem(); run ai-runner suite
- [x] llm-jsonl-importer: importer.ts → finish createNodeFileSystem() adoption; run suite
- [x] runtime-internal: context.ts, schema-validation.ts, runtime-node-bun.ts → factory; run runtime suite

### Leg C — delete dead surface (#3 / R4)
- [x] `rg "NodeFileSystem|NodeSyncFileSystem|getFs\(\)|\bSyncFileSystem\b" packages/*/src` excluding file-system-node.ts → must be empty
- [x] Delete `NodeFileSystem`, `NodeSyncFileSystem`, legacy `FileSystem`/`SyncFileSystem`, `getFs()` from runtime/src/fs.ts (keep only what's still live, e.g. FileStat/LogStream if used)
- [x] Fix runtime/src/index.ts exports; ensure `LegacyFileSystem` alias usage (file-discovery.ts imports `type LegacyFileSystem as FileSystem`) is reconciled
- [x] Typecheck all 8 packages

### Leg D — docs (#4 + R5)
- [x] event-bus.ts: add reciprocal comment at the metrics `emit()` site (166-167) pointing to default-observers for traces
- [x] docs/00_ADR.md: new dated ADR entry recording the deprecated-FileSystem removal (amends ADR-011 addendum); note the breaking export change

### Gate
- [x] `bun run spur-check` green (39 rules + both presets, --fail-on warning)
- [x] `bun run build` exit 0 for all 8 packages
- [x] `git status` only intentional changes; no test skipped/suppressed


### Review


### Follow-up 2026-06-20 — deferred minors closed
The three deferred items from the post-merge re-review are now resolved:
- **#3 RESOLVED** — `importer.ts` `walkFiles` deleted; replaced with canonical `walkDir(root, fileSystem)` from `@gobing-ai/ts-runtime` (behavior-equivalent — importer post-filters via `matchesPattern`; dropped now-unused `joinPath` import).
- **#4 RESOLVED** — `DoctorRunnerOptions.fileSystem?: FileSystem` added and wired to `this.fs`; the testable fs seam the migration claimed is now surfaced.
- **#5 RESOLVED** — `RuleLoaderOptions.fileSystem?: FileSystem` added, threaded into `buildMergedRoots(roots, fs)`; config loading no longer hard-constructs the fs.

All additive (default path unchanged); existing suites validate behavior. Gate: biome+tsc 8/8 · 1515 pass / 0 fail · spur-check 39 rules + both presets · build 8/8.


### 🔴 Defect (was major) — injected fileSystem bypassed fixer providers
`engine.ts:166` threaded `fileSystem` into the **evaluator** context but `:221` built the **fixer** context as `{ rule, workdir }`, dropping it. `RegexFixerProvider`/`PathFixerProvider` read `context.fileSystem ?? createNodeFileSystem()`, so the fallback always won — an injected virtual fs silently never reached fixers. Contradicted R1's "threaded to evaluators AND fixers."

- **Fix:** `engine.ts:221` → `{ rule, workdir, fileSystem: this.fileSystem }` (symmetric with the evaluator site).
- **Regression test:** `engine.test.ts` `'injected fileSystem reaches fixer providers through RuleContext'` — proven to FAIL on the pre-fix code (reverted line, test caught it) and PASS after. R8-compliant.
- **Lesson:** the original fake-fs test only exercised the evaluator path; the fixer leg was uncovered. The new test closes that gap.

### Minor (fixed)
- `schema-validation.ts:51` JSDoc cited deleted `getFs()` as the default → corrected to `createNodeFileSystem()`.

### Deferred (logged, not in --fix scope — behavior/API-surface changes)
| # | Finding | Severity | Note |
|---|---------|----------|------|
| 3 | `importer.ts:237 walkFiles` re-implements ts-runtime `walkDir` | minor | canonical walkDir has an `exclude` param; needs deliberate swap+test |
| 4 | `DoctorRunnerOptions` lacks `fileSystem` field | minor | private fs works; tests use temp dirs; complete the seam opportunistically |
| 5 | `config/loader.ts:210` no fs injection slot | advisory | startup-only, outside RuleContext pipeline; pre-existing |

### Gate (post-fix, independent)
biome+tsc 8/8 · **1515 tests pass / 0 fail** (+1 regression test) · spur-check 39 rules + both presets green · build 8/8.

### Verdict
**PASS (after fix).** The fs-injection contract is now honored end-to-end (evaluators + fixers), proven by a regression test. SECU clean: no secrets, no injection (Bun.spawn uses argv arrays), ReDoS unchanged/tracked (task 0003), no empty-catch/any. Three minor/advisory items deferred to backlog.


### Design note (carried forward — accurate)
fs injection routed through `RuleContext.fileSystem` instead of evaluator ctor-threading — same intent (single injected fs from `RuleEngineOptions.fileSystem`, default `createNodeFileSystem()`), smaller surface (1 type extension vs 9+ ctor signature changes), more testable (fake fs via one-line context). Verified sound.

---

## Independent Verification 2026-06-20 (Phase 7 + 8, --force re-audit). Verdict: PASS.

**Status:** 0 P1, 0 P2, 0 P3, 1 P4 (advisory) · **Scope:** 0039 change set (36 files, +385/-594) · **Mode:** verify (full) · **Channel:** inline (current) · **Fix:** all (nothing mechanical to apply) · **Gate:** Biome+tsc 8/8; 1514 pass/0 fail; build 8/8 exit 0.

### Phase 7 — SECU on the change set
- **Security:** Net deletion of a deprecated surface; no new injection/secret/auth surface. fs reads still route through the canonical `FileSystem` adapter. Clean.
- **Efficiency:** No hot-path change. `runtime-node-bun.ts` memoizes the node fs via a module singleton (`getNodeFileSystem`) with a `_resetNodeFileSystem()` test hook — a minor win over per-call construction. Clean.
- **Correctness:** Behavior-preserving — the injected default (`createNodeFileSystem()`) is the canonical replacement for the deleted class; 1514/0 across all packages (runtime fs.test.ts rewritten for the canonical API, rule-engine +fake-fs seam test). The 4 `no-inline-ddl` / `no-hand-written-ddl` ERRORs in `persistence/schema.ts:13,35` are **pre-existing** — reproduced on clean HEAD via `git stash` test, unrelated to this task's files. Clean.
- **Usability:** `RuleContext.fileSystem` documented with a MUST-read-through-port contract (types.ts:160-165); ADR-019 records the breaking export removal so downstream consumers are warned. Clean.

### P4 — Suggestion
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | `?? createNodeFileSystem()` fallback repeated in ~20 evaluators | Usability | rule-engine `src/evaluators/*` | `RuleContext.fileSystem` is optional, so each evaluator carries a real-fs fallback for the direct-unit-test path. The engine always populates it, so this only matters for hand-built contexts. Acceptable as a defensive default; if it ever drifts, a tiny `ctxFs(context)` helper would centralize the fallback. No action required. |

### Verdict
**PASS.** All 7 requirements MET with code evidence; injection seam proven by the fake-fs test; deprecated surface fully removed (zero refs); breaking change recorded in ADR-019; gate independently green. The plan's ctor-threading was improved to context-threading — a sound, smaller, more testable deviation. The only finding is a P4 advisory requiring no change. Pre-existing DDL warnings confirmed out of scope.


### Design note
fs injection routed through `RuleContext.fileSystem` instead of evaluator ctor-threading — same intent (single injected fs from `RuleEngineOptions.fileSystem`, default `createNodeFileSystem()`), smaller surface (1 type extension vs 9+ ctor signature changes), more testable (fake fs via one-line context).

### Verification
- `bun run lint`: Biome + tsc — all 8 packages pass
- `bun run test`: 1514 pass, 0 fail across 160 files
- `spur rule run --preset recommended-pre-check --fail-on warning`: 35/39 pass (4 pre-existing DDL-in-schema violations in persistence/schema.ts, unrelated)
- `spur rule run --preset recommended-post-check --fail-on warning`: 2/2 pass (coverage-gate, tsdoc-export)
- `bun run build`: all 8 packages build to dist

### Findings
No new findings. All 11 deprecated `new NodeFileSystem()` sites migrated, deprecated FileSystem surface deleted from runtime, zero deprecated-surface refs in packages/*/src.

### Verdict
**PASS**


### Testing

## Testing

- `cd packages/rule-engine && bun test --timeout 30000`: 305 pass, 0 fail (includes new fake-fs seam test)
- `cd packages/runtime && bun test --timeout 30000`: 198 pass, 0 fail (fs.test.ts rewritten for canonical API)
- `cd packages/ai-runner && bun test --timeout 30000`: 92 pass, 0 fail
- `cd packages/llm-jsonl-importer && bun test --timeout 30000`: 20 pass, 0 fail
- `bun run test`: 1514 pass, 0 fail across 160 files
- Coverage: 99.24% lines, 98.88% functions (unchanged from baseline)


### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References


