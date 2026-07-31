---
schema_version: 1
name: ProcessExecutor observability ports and typed event maps
status: done
type: task
profile: standard
priority: P1
tags: [ai-runner,runtime,observability,events,otel]
created_at: 2026-06-05T05:24:51.840Z
updated_at: 2026-06-05T05:43:30.000Z
---

## 0018. ProcessExecutor observability ports and typed event maps

### Background

ts-runtime ProcessExecutor.run()/runStreaming() emit no events and open no OTel span (bare execa/Bun.spawn) — total loss of process-level observability vs spur-old, which emitted process.started/process.exited on an EventBus and wrapped each run in a span. ProcessExecutor cannot import EventBus from ts-infra: that forms a cycle (ts-runtime -> ts-infra -> ts-db -> ts-runtime). Per the new ADR-013 Addendum (Observability Layering, 2026-06-04), at/below-ts-infra code emits through zero-dependency structural ports; the concrete EventBus/traceAsync adapter is injected from a higher layer. This task lays the foundation that tasks B and C build on. Brainstorm: docs/plans/2026-06-04-ai-runner-migration-drift-brainstorm.md (F2, F7).


### Requirements

Each item is independently verifiable. "Done" = all acceptance criteria (AC) met with tests + green gate.

1. **Structural ports defined in `ts-runtime` (zero ts-infra dependency).**
   - AC: `ProcessEventSink` interface exists with `emit(event: 'process.started' | 'process.exited', detail: ProcessEventDetail): void`.
   - AC: `TracerPort` interface exists with `traceAsync<T>(name: string, fn: (span) => Promise<T>): Promise<T>`.
   - AC: `ProcessEventDetail` carries `command`, `args`, `exitCode`, `signal`, `durationMs`, `reason: 'exit' | 'signal' | 'timeout' | 'error'`, `timestamp`, optional `label`/`error`.
   - AC: grep confirms no `@gobing-ai/ts-infra` import anywhere in `ts-runtime/src/`.

2. **`ProcessExecutor.run()` emits + traces.**
   - AC: emits `process.started` before launch and `process.exited` on completion.
   - AC: on non-zero exit / signal / timeout / error, `process.exited` carries the correct `reason` and `exitCode`/`signal`.
   - AC: the whole run is wrapped in a span opened via `TracerPort`.

3. **`ProcessExecutor.runStreaming()` emits + traces.**
   - AC: emits `process.started` on spawn and `process.exited` once the subprocess exits (wired to the `PipeProcess.exited` resolution).
   - AC: the spawn is wrapped in a span via `TracerPort`.

4. **No-op by default — existing callers unaffected.**
   - AC: when no `events`/`tracer` is supplied, `run()`/`runStreaming()` behave exactly as before (no throw, same `ProcessResult`/`PipeProcess`).
   - AC: pre-existing ts-runtime + ai-runner tests pass unchanged.

5. **Typed event maps authored.**
   - AC: `ProcessEvents` map (`process.started`/`process.exited` → detail) is consumable as `EventBus<ProcessEvents>`.
   - AC: `AgentEvents` map (`agent.*`) is authored in `ts-ai-runner` for task 0020 to consume (declaration only; emission is 0020's scope).

6. **ai-runner injects concrete adapters.**
   - AC: `ts-ai-runner` constructs an `EventBus`-backed `ProcessEventSink` (`{ emit: (e, d) => bus.emit(e, d) }`) and a `traceAsync`-backed `TracerPort`, and passes them into the `ProcessExecutor` it builds.
   - AC: `process.*` events are observable on the injected `EventBus` end-to-end through an `AiRunner` invocation.

7. **Quality gate.**
   - AC: new tests cover emit-on-success, emit-on-failure (each `reason`), span-open, and no-op-when-unset.
   - AC: `bun run spur-check` and `bun run build` both pass; `git status` shows only intentional changes.


### Q&A



### Design

**Technical**
- `ts-runtime` MUST NOT import `@gobing-ai/ts-infra` — it would form the cycle `ts-runtime → ts-infra → ts-db → ts-runtime`. Observability flows through structural ports only (ADR-013 Addendum, 2026-06-04).
- `EventBus` is heavyweight (`Logger`, `JobQueue`, telemetry metrics) and stays in `ts-infra`; it is NOT relocated downward.
- Ports MUST be `interface`-only with no-op default behavior — zero runtime cost when unset.
- Platform/process APIs stay confined to `ts-runtime` per ADR-011 (`runtime-boundaries`); no new `node:*`/`Bun.*` usage leaks into ai-runner.

**Consistency**
- Span event names and `EventBus` event names MUST share the `process.` dotted prefix to keep traces and subscribers aligned.
- New cross-package dep edges (if any) must keep `workspace:*` + `tsconfig` path alias in sync (ADR-002/ADR-004).

**Scope boundaries (must NOT)**
- Do NOT emit `agent.*` events here — `AgentEvents` is declared only; emission is task 0020.
- Do NOT modify `TeamAgentProcess` process management — that is task 0019.
- Do NOT add the enforcing spur rule in this task — optional follow-up (ADR-006).

**Dependencies**
- Blocks: tasks 0019 and 0020 (both consume the ports/event maps defined here).
- Requires: ADR-013 Addendum (already authored, `docs/00_ADR.md`, 2026-06-04).


### Solution

Structural dependency-inversion seam (operator-confirmed). ProcessEventSink + TracerPort are interface-only in ts-runtime/src/process-executor.ts (zero runtime cost when unset). Concrete adapters live in ts-ai-runner: { emit: (e,d) => bus.emit(e,d) } and { traceAsync }. Span event names and EventBus names share the process.* prefix to keep traces and subscribers aligned. Follows ADR-013 Addendum (2026-06-04). Optional follow-up: a spur rule (ADR-006) enforcing that runtime-layer emitters use a port and never import ts-infra.


### Plan

1. Add zero-dependency `ProcessEventSink`, `TracerPort`, `ProcessEventDetail`, and `ProcessEvents` types to `ts-runtime` and export them from the runtime barrel.
2. Wrap `ProcessExecutor.run()` with the tracer port and emit `process.started` / `process.exited` for success, non-zero exits, signals, timeouts, and command errors while preserving existing no-throw behavior unless `rejectOnError` is set.
3. Wrap `ProcessExecutor.runStreaming()` spawn with the tracer port, decorate the returned `PipeProcess.exited` promise, and preserve the synchronous streaming API.
4. Add `AgentEvents` declarations in `ts-ai-runner` for task 0020 and wire AiRunner-owned default executors with an EventBus-backed process sink plus `traceAsync` tracer adapter.
5. Cover new behavior with runtime and ai-runner tests, then run the repository gates.


### Review

PASS

## Verify — 2026-06-05 (re-audit via `/rd3:dev-verify 0018 --auto --fix all --force`)

**Mode:** full (Phase 7 SECU + Phase 8 traceability) · **Channel:** inline (dogfood rule) · **Gate:** `bun run spur-check` → PASS (1129 tests, 0 fail; all 34+ spur rules incl. runtime-boundaries, coverage-gate, tsdoc-export). `bun run build` → PASS (8/8 packages).

### Phase 7 — SECU findings

| # | Title | Dimension | Location | Recommendation | Status |
|---|-------|-----------|----------|----------------|--------|
| 1 | Spawn-failure had no terminal event | Correctness | `process-executor.ts:224` | On `Bun.spawn` failure, `runStreaming` emitted `process.started` but no terminal event, leaving observers with a dangling start. | **FIXED** |

No P1/P2 findings. No Security surface (observability plumbing — no secrets/injection/auth/data-exposure). No Efficiency regressions. Correctness is strongly covered (all four `reason` values + no-op tested). Empty-`catch` concern (F9) is scoped to task 0019, not here.

**Fix pass (`--fix all`):** Finding #1 resolved — `runStreaming` now emits a terminal `process.exited` with `reason: 'error'` + `error` message on spawn failure, giving observers a symmetric started→exited pair (`process-executor.ts:224-235`). Regression test added (`process-executor.test.ts:197` "runStreaming emits a terminal exited event when spawn fails"). Gate re-run: `bun run spur-check` → PASS (1130 tests, 0 fail, all 34 rules); `bun run build` → 8/8.

### Phase 8 — Requirements traceability (7/7 MET)

- [x] **R1** ports defined, zero ts-infra import → **MET** | `process-executor.ts:46` `ProcessEventDetail`, `:59` `ProcessEventSink`, `:70` `TracerPort`, `:43` `ProcessExitReason`; `rg '@gobing-ai/ts-infra' packages/runtime/src` → no matches.
- [x] **R2** `run()` emits + traces (all reasons) → **MET** | `:119-186` (started before launch, exited with reason exit/timeout/signal/error), span via `:233 trace()`. Tests: `process-executor.test.ts:88,117,128,140,153`.
- [x] **R3** `runStreaming()` emits + traces → **MET** | `:194-231` started on spawn; `ObservedPipeProcess` (`:269-297`) emits exited from `PipeProcess.exited`; spawn span `:198`. Tests: `:170,188`.
- [x] **R4** no-op by default → **MET** | `emitProcessEvent` (`:264`) and `trace` (`:233`) guard on undefined; existing callers unchanged. Test: `:197` "observability ports are no-op when unset"; full suite green.
- [x] **R5** typed event maps → **MET** | `ProcessEvents` (`process-executor.ts:64`); `AgentEvents` authored for task 0020 in `ai-runner/src/events.ts:4` (declaration only).
- [x] **R6** ai-runner injects adapters → **MET** | `ai-runner.ts:62-75` default `NodeProcessExecutor` gets EventBus-backed sink (`:66`) + traceAsync-backed tracer (`:73`). Test: `ai-runner.test.ts` (process events observable end-to-end).
- [x] **R7** quality gate → **MET** | emit-on-success/failure(each reason)/span/no-op all tested; spur-check + build green; `git status` shows only intentional changes (3 src + 3 test + 2 index).

### Verdict: **PASS** (7/7 met)

Implementation matches the refined requirements with no scope drift. Dependency-inversion seam is clean (ADR-013 Addendum, ADR-011 boundary intact). One P3/optional correctness note (spawn-failure span). Tasks 0019/0020 unblocked.


### Testing

2026-06-05T05:43:30-07:00 verification:

- `bun run --cwd packages/runtime lint` — PASS.
- `bun run --cwd packages/runtime test` — PASS, 188 tests.
- `bun run --cwd packages/ai-runner lint` — PASS.
- `bun run --cwd packages/ai-runner test` — PASS, 70 tests.
- `rg '@gobing-ai/ts-infra' packages/runtime/src` — PASS, no matches.
- `bun run spur-check` — PASS: root lint/typecheck, 34 pre-check spur rules, 1129 tests, coverage gate, TSDoc export gate.
- `bun run build` — PASS: all 8 packages built.


### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |
| code | `packages/runtime/src/process-executor.ts` | Codex | 2026-06-05 |
| code | `packages/runtime/src/index.ts` | Codex | 2026-06-05 |
| code | `packages/ai-runner/src/ai-runner.ts` | Codex | 2026-06-05 |
| code | `packages/ai-runner/src/events.ts` | Codex | 2026-06-05 |
| test | `packages/runtime/tests/process-executor.test.ts` | Codex | 2026-06-05 |
| test | `packages/ai-runner/tests/ai-runner.test.ts` | Codex | 2026-06-05 |
| test | `packages/ai-runner/tests/events.test.ts` | Codex | 2026-06-05 |

### References


### History

- Migrated from legacy format (2026-07-31)
