---
name: "runtime: retire deprecated FileSystem surface + rule-engine fs injection port"
description: "runtime: retire deprecated FileSystem surface + rule-engine fs injection port"
status: Todo
created_at: 2026-06-20T05:58:54.732Z
updated_at: 2026-06-20T05:59:51.351Z
folder: docs/tasks
type: task
feature-id: ""
priority: high
estimated_hours: 14
dependencies: ["0012","0013"]
tags: ["refactor","runtime","rule-engine","migration","testability"]
impl_progress:
  planning: pending
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

## 0039. "runtime: retire deprecated FileSystem surface + rule-engine fs injection port"

### Background

Architecture-review cluster: finding #3 (major, runtime), #1 (major, rule-engine), #4 (advisory doc note, infra) from the 2026-06-19 dev-review over packages/. ROOT CAUSE shared by #1 and #3: an incomplete filesystem-injection story. ts-runtime exposes the ADR-011 union-return FileSystem (file-system.ts) + createNodeFileSystem() factory (file-system-node.ts) as the canonical surface, but the DEPRECATED async NodeFileSystem class, NodeSyncFileSystem, the legacy FileSystem/SyncFileSystem interfaces, and the getFs() singleton all still live in fs.ts and are consumed by 54 references across 16 files in 4 packages (runtime, rule-engine, ai-runner, llm-jsonl-importer). Split-brain: a new reader must untangle 'which FileSystem do I use?' on every file touch. Separately, RuleEngineOptions injects processExecutor but has NO fileSystem port, so 11 sites construct 'new NodeFileSystem()' directly (3 now live in evaluators/file-discovery.ts after task 0039-pre file-utils split) — every fs-touching evaluator/fixer is untestable without monkey-patching. Predecessor: task 0004 built the scanFiles seam these evaluators share; this task adds the injection the seam was missing. Reviewer recommendation: pair #1 and #3 (do NOT touch rule-engine fs twice) — #1's sites are a SUBSET of #3's migration, so land the injection port as the rule-engine leg of the #3 sweep. #4 is a 10-line doc comment, fold into this PR for free.


### Requirements

R1 — RuleEngineOptions gains an optional fileSystem port (ADR-011 union-return FileSystem) threaded host→registerBuiltins→evaluator/fixer constructors; default createNodeFileSystem(). R2 — all 11 rule-engine 'new NodeFileSystem()' sites consume the injected fs (none construct their own). R3 — migrate the remaining deprecated-surface consumers (ai-runner, llm-jsonl-importer, runtime-internal) off NodeFileSystem class / getFs() onto createNodeFileSystem(). R4 — delete the deprecated NodeFileSystem class, NodeSyncFileSystem, legacy FileSystem/SyncFileSystem interfaces, and getFs() from fs.ts once zero consumers remain; update runtime index exports. R5 — add a dated ADR entry recording the deprecated-surface removal (amends ADR-011 addendum). R6 — #4: document the EventBus two-layer observability model (inline metrics in emit() + observer-based traces) with a comment cross-referencing both files. R7 — gate green (bun run spur-check + bun run build); no behavior change; new injection covered by a test that swaps a BufferTarget-style fake fs.


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
- [ ] Add `fileSystem?: FileSystem` (ADR-011 union-return) to `RuleEngineOptions` in `engine.ts`, beside `processExecutor`; default `createNodeFileSystem()` in the ctor
- [ ] Thread the fs through `registerBuiltins` + `registerBuiltinFixers` (host/builtins.ts, fixers/fixers.ts) into each evaluator/fixer ctor
- [ ] Replace the 11 inline `new NodeFileSystem()` with the injected fs: fixers.ts:69,176,223 · test-stub-fixer.ts:27 · coverage-gate-evaluator.ts:50 · schema-artifact-evaluator.ts:28 · file-discovery.ts:38,51,98 · path-evaluator.ts:25 · config/loader.ts:209
- [ ] bundled-rules.ts: route its fs through the same port
- [ ] Add a test swapping a fake fs via the new port (proves the seam); run full rule-engine suite — must stay green unchanged

### Leg B — migrate remaining deprecated-surface consumers (#3)
- [ ] ai-runner: doctor-runner.ts (also unblocks #18 testability), agent-spec.ts → createNodeFileSystem(); run ai-runner suite
- [ ] llm-jsonl-importer: importer.ts → finish createNodeFileSystem() adoption; run suite
- [ ] runtime-internal: context.ts, schema-validation.ts, runtime-node-bun.ts → factory; run runtime suite

### Leg C — delete dead surface (#3 / R4)
- [ ] `rg "NodeFileSystem|NodeSyncFileSystem|getFs\(\)|\bSyncFileSystem\b" packages/*/src` excluding file-system-node.ts → must be empty
- [ ] Delete `NodeFileSystem`, `NodeSyncFileSystem`, legacy `FileSystem`/`SyncFileSystem`, `getFs()` from runtime/src/fs.ts (keep only what's still live, e.g. FileStat/LogStream if used)
- [ ] Fix runtime/src/index.ts exports; ensure `LegacyFileSystem` alias usage (file-discovery.ts imports `type LegacyFileSystem as FileSystem`) is reconciled
- [ ] Typecheck all 8 packages

### Leg D — docs (#4 + R5)
- [ ] event-bus.ts: add reciprocal comment at the metrics `emit()` site (166-167) pointing to default-observers for traces
- [ ] docs/00_ADR.md: new dated ADR entry recording the deprecated-FileSystem removal (amends ADR-011 addendum); note the breaking export change

### Gate
- [ ] `bun run spur-check` green (39 rules + both presets, --fail-on warning)
- [ ] `bun run build` exit 0 for all 8 packages
- [ ] `git status` only intentional changes; no test skipped/suppressed


### Review



### Testing



### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References


