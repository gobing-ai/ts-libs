# AI-Runner Migration Drift — Review & Solution Brainstorm

**Task:** `docs/tasks/0017_review_on_ai-runner_after_the_migration.md`
**Date:** 2026-06-04
**Scope:** Compare new `packages/ai-runner` (`@gobing-ai/ts-ai-runner`) against the old `~/xprojects/spur-old/packages/kernel/src/ai-runner` + `…/core/src/process-executor`; produce a severity-ranked findings list and a solution for observability + process-management drift.

---

## Overview

The migration extracted ai-runner into an independent package and added **team mode** (new feature, no old counterpart). Three classes of drift confirmed by code inspection:

1. **Process management** — `TeamAgentProcess` bypasses the executor with raw `processSpawner.spawn()` + `process.kill('SIGTERM'/'SIGKILL')`, losing lifecycle management and observability.
2. **Observability** — The old `ProcessExecutor` emitted `process.started`/`process.exited` on an `EventBus` and wrapped every run in an OTel span. The **new `ts-runtime` `ProcessExecutor` emits nothing and has no span**. No `agent.*` or `process.*` events exist anywhere in the new tree. `TeamOrchestrator` reinvented a private `on()/emit()` listener system instead of using `ts-infra`'s `EventBus`.
3. **Feature parity** — `agent-detector` (237→93 LOC) and `doctor-runner` (329→175 LOC) shed significant logic during migration; needs an audit to confirm what (if anything) was lost vs intentionally simplified.

**Central architectural constraint (verified):** the dependency graph is `ts-utils → ts-runtime → ts-db → ts-infra → ts-ai-runner`. `EventBus`/OTel live in `ts-infra`, **two layers above `ts-runtime`**. `ProcessExecutor` therefore **cannot import `EventBus` directly** — doing so creates a hard cycle `ts-runtime → ts-infra → ts-db → ts-runtime`. `EventBus` is also heavyweight (pulls in `Logger`, `JobQueue`, telemetry metrics), so relocating it down is not viable.

**Resolved design (operator-confirmed):** dependency-inversion seam. `ProcessExecutor` owns `process.*` events + OTel spans, emitting through zero-dependency **structural ports** (`ProcessEventSink`, `TracerPort`) defined in `ts-runtime`. The concrete `EventBus`/`traceAsync` are injected from `ts-ai-runner` (which has `ts-infra`). Semantic `agent.*` events layer on top in ai-runner. This honors "events live with the executor," avoids the cycle, and matches the ADR-013 injected-bus philosophy.

---

## Findings List (severity-ranked)

| # | Severity | Area | Finding | Evidence |
|---|----------|------|---------|----------|
| F1 | **Critical** | Process mgmt | `TeamAgentProcess` spawns via raw `processSpawner.spawn()` and kills via raw `process.kill('SIGTERM'/'SIGKILL')`, bypassing the executor. No lifecycle events, no observability, duplicate spawn logic. The executor already exposes `runStreaming()` returning the same `PipeProcess`. | `team-agent-process.ts:53,80,86` vs `process-executor.ts:runStreaming` |
| F2 | **Critical** | Observability | New `ts-runtime` `ProcessExecutor.run()` emits **no `process.started`/`process.exited` events and wraps no OTel span** — bare `execa`. Old executor did both. Total loss of process-level observability for the *correct* `AiRunner` path too. | `process-executor.ts:84-130` vs old `process-executor.ts:108-210` |
| F3 | **High** | Observability | No `agent.*` events emitted anywhere. `AiRunner` only logs (`logger.debug/error`); no `agent.invoke.start`/`agent.invoke.exit` on the bus. | `ai-runner.ts:98-126` |
| F4 | **High** | Observability | `TeamOrchestrator` uses a **hand-rolled private `on()/emit()`** listener map (`agent.started`, `agent.stopped`, `message.sent`) instead of `ts-infra` `EventBus`. Inconsistent with ADR-013; events not observable by standard subscribers. | `team-orchestrator.ts:8-9,116-122,168-170` |
| F5 | **Medium** | Parity | `agent-detector` shrank 237→93 LOC. Old had `detectOneByProbe`, `parseProbeResult`, `detectChannels`; new has a flat `detectOne`. Confirm probe richness / channel detection wasn't silently dropped. | old `agent-detector.ts:139-232` vs new `agent-detector.ts:45-91` |
| F6 | **Medium** | Parity | `doctor-runner` shrank 329→175 LOC. Audit auth-flow + tier logic for dropped checks. | old `doctor-runner.ts` (329) vs new (175) |
| F7 | **Medium** | Consistency | Event-name taxonomy undefined. Old used `process.started`/`process.exited`. New needs a typed event map: `process.*` (executor) + `agent.*` (ai-runner). Prefixes per task: `process.` and `agent.`. | task §"What I already found" |
| F8 | **Low** | Maintainability | Adding a coding agent touches 6 spots (`AgentName` union, `AGENT_SHIMS`, `TIER1_PRIORITY`, `DISPLAY_ORDER`, `TIER2_AGENTS`, `isAgentName`). No single source of truth. | `agents/shims.ts:2,160-193` |
| F9 | **Low** | Observability | `TeamAgentProcess` has no `Logger` at all; failures are swallowed in empty `catch {}` blocks (`stop()`, `pipe()`, `send()`). | `team-agent-process.ts:77,100,134` |

---

## Solution Approaches

### Approach 1: Dependency-Inversion Seam (executor owns `process.*`) ⭐ Recommended — **confirmed**

**Description.** Define zero-dependency structural ports in `ts-runtime`: `ProcessEventSink` and `TracerPort`. `ProcessExecutor.run()` (and `runStreaming()`) emit `process.*` events and open spans through these ports. `ts-ai-runner` injects `EventBus`-backed and `traceAsync`-backed adapters. `AiRunner` and `TeamOrchestrator` additionally emit semantic `agent.*` events on the real `EventBus`. `TeamAgentProcess` is rerouted through `executor.runStreaming()` and given a `Logger` + the same sink. `TeamOrchestrator`'s private listener map is replaced by `EventBus`.

```ts
// ts-runtime/src/process-executor.ts — structural ports, zero ts-infra import
export interface ProcessEventDetail {
  command: string; args: string[]; label?: string;
  exitCode?: number | null; signal?: string; durationMs?: number;
  reason?: "exit" | "signal" | "timeout" | "error"; error?: string;
  timestamp: number;
}
export interface ProcessEventSink {
  emit(event: "process.started" | "process.exited", detail: ProcessEventDetail): void;
}
export interface TracerPort {
  traceAsync<T>(name: string, fn: (span: SpanLike) => Promise<T>): Promise<T>;
}
```

```ts
// ts-ai-runner — adapt real EventBus + traceAsync to the ports
const sink: ProcessEventSink = { emit: (e, d) => bus.emit(e, d) };
const tracer: TracerPort = { traceAsync };
new ProcessExecutor({ events: sink, tracer });
```

**Trade-offs**
- **Pros:** `process.*` lives with the executor (operator's instinct); no dependency cycle; ADR-013-aligned (injected bus); ports are tiny + testable; OTel restored at both layers; `runStreaming` reuse kills the F1 duplication.
- **Cons:** introduces a port abstraction in `ts-runtime` (one more concept); ai-runner must wire two adapters; event-map types must be authored.

**Implementation notes:** ports are `interface`-only (no runtime cost when unset). Default = no-op, so existing callers are unaffected. Likely needs an ADR addendum sanctioning structural observability ports at the runtime boundary (extends ADR-011/ADR-013).

**Confidence:** HIGH — graph, executor body, and ADR-013 pattern all verified in-repo today.

---

### Approach 2: `process.*` in ai-runner only (executor untouched)

**Description.** Leave `ts-runtime` alone. `AiRunner` + `TeamAgentProcess`/`TeamOrchestrator` emit **both** `process.*` and `agent.*` on the injected `EventBus`, deriving `process.*` from each `ProcessResult` / lifecycle call.

**Trade-offs**
- **Pros:** smallest change to `ts-runtime`; no new abstraction; pure ADR-013 consumer-injection.
- **Cons:** executor doesn't own its own lifecycle events (semantically wrong — operator flagged this); `process.*` emission duplicated across every call site; `runStreaming` still has no span; F1 duplication persists unless separately addressed.

**Confidence:** HIGH (viable, but rejected — misplaces `process.*`).

---

### Approach 3: Relocate `EventBus`/telemetry toward `ts-utils`

**Description.** Move `EventBus` (+ `Logger`, `JobQueue`, telemetry metrics) down so `ts-runtime` can import it directly and emit natively.

**Trade-offs**
- **Pros:** executor emits real events with no indirection; one event system everywhere.
- **Cons:** massive blast radius; inverts the architecture (infra concerns in utils); contradicts ADR-013's deliberate placement; drags `JobQueue`/metrics into the base layer. **Not recommended.**

**Confidence:** HIGH that this is the wrong trade-off.

---

## Recommendation

**Approach 1 — confirmed by operator**, with **events + OTel in the same pass** (structural `ProcessEventSink` + `TracerPort` in `ts-runtime`; real `EventBus` + `traceAsync` injected from `ts-ai-runner`).

**Execution order (audit-first):**

1. **Findings audit** (this doc) → confirm F5/F6 parity gaps before touching code.
2. **F7** — Author typed event maps: `ProcessEvents` (`process.started`/`process.exited`) and `AgentEvents` (`agent.invoke.start`/`agent.invoke.exit`/`agent.started`/`agent.stopped`/`agent.message.sent`).
3. **F2** — Add `ProcessEventSink` + `TracerPort` ports to `ts-runtime`; wire `run()` + `runStreaming()` to emit + span (no-op default).
4. **F1 + F9** — Reroute `TeamAgentProcess` through `executor.runStreaming()`; inject `Logger` + sink; remove silent `catch {}` swallowing.
5. **F3 + F4** — Emit `agent.*` from `AiRunner`; replace `TeamOrchestrator`'s private listeners with injected `EventBus`.
6. **F5 + F6** — Decompose parity restoration into follow-up tasks based on audit results.
7. **F8** — **Deferred** to its own task: single-source agent registry.

**ADR note:** steps 2–3 introduce observability ports at the `ts-runtime` boundary — author an ADR addendum (extends ADR-011 runtime-boundaries + ADR-013 injected-bus) before merging.

---

## Open Decisions (deferred, not blocking)

- **F8 agent registry refactor** — single descriptor → derive union/tiers/order. Separate task to avoid entangling the observability fix.
- **F5/F6 parity depth** — exact scope set by the audit in step 1.

## Next Steps (task candidates)

1. `feat(ai-runner): typed process.*/agent.* event maps + observability ports` (F2, F7)
2. `fix(ai-runner): route TeamAgentProcess through executor.runStreaming + logger` (F1, F9)
3. `feat(ai-runner): emit agent.* events; EventBus-backed TeamOrchestrator` (F3, F4)
4. `chore(ai-runner): audit agent-detector/doctor-runner parity vs spur-old` (F5, F6)
5. `refactor(ai-runner): single-source agent registry` (F8 — deferred)
6. `docs(adr): observability layering — injected EventBus vs structural port` (ADR addendum)

---

## Workspace-Wide Observability Standardization

**Question raised:** should the structural-sink pattern be standardized across all engines (`rule-engine`, `dual-workflow-engine`, …) before the repo ossifies?

**Answer (verified in-repo 2026-06-04): No single pattern — there are two, selected by dependency layer.** Forcing the sink everywhere would add pointless indirection where a direct `EventBus` import is already legal and shipped.

### Current state (audited)

| Package | Layer vs `ts-infra` | Pattern today | Status |
|---------|---------------------|---------------|--------|
| `rule-engine` | above | injected `EventBus<RuleEngineEvents>` + `getLogger` + `traceAsync`, owned event map | ✅ canonical |
| `dual-workflow-engine` | above | injected `EventBus<WorkflowEngineEvents>` + logger + `traceAsync` via `RunLifecycle` seam | ✅ canonical |
| `ai-runner` | above | partial — logger only, no events; team mode reinvented private `on()/emit()` | ❌ drift (this task) |
| `llm-jsonl-importer` | above | none — no logger/events/traces | ⚠️ gap (separate review, deferred) |
| `ProcessExecutor` (`ts-runtime`) | **at/below** | none — and *cannot* import `EventBus` (cycle through `ts-db`) | ❌ F2 — needs sink |

`rule-engine` and `dual-workflow-engine` already converged on exactly the ADR-013 injected-bus pattern. They do **not** need the sink. The structural sink is the **boundary exception** for code at/below `ts-infra`; today that is `ProcessExecutor` alone (`fs.ts:320` `on(` match was a false positive — `atomicWriteJson`; no hidden third event system exists below infra).

### The standard (two patterns, layer-selected)

```text
IF package sits ABOVE ts-infra (can import it without a cycle):
    → inject EventBus<XEvents> directly + getLogger() + traceAsync()
    → own a typed event map (XEvents) in the package
    (rule-engine, dual-workflow-engine, ai-runner consumer layer, llm-jsonl-importer)

IF code sits AT or BELOW ts-infra (importing EventBus would create a cycle):
    → emit through a zero-dependency structural port (e.g. ProcessEventSink, TracerPort)
    → a higher layer injects the concrete EventBus/traceAsync adapter
    (ts-runtime ProcessExecutor — the only current case)
```

**Selection rule of thumb:** can the package `import { EventBus } from '@gobing-ai/ts-infra'` without forming a cycle? If yes → direct injection. If no → structural port.

### Recommended actions (this is option 1; llm-jsonl-importer deferred)

1. **ADR addendum** — codify both patterns and the layer-based selection rule (folds into next-step task #6). Extends ADR-013 (injected bus, "above" case) with the new "at/below" structural-port case; references ADR-011 runtime-boundaries.
2. **Optional spur rule** (ADR-006 — "invariants are rules, not review habits") — packages depending on `ts-infra` that emit lifecycle behavior must accept `events?: EventBus<...>`; runtime-layer lifecycle emitters must use a structural port, never import `ts-infra`. Turns the convention into an enforced invariant.
3. **Deferred** — `llm-jsonl-importer` observability gap: reviewed separately later (operator decision). When addressed, it uses the **direct-injection** pattern (it sits above `ts-infra`).

### ADR Addendum — draft text

> **ADR-0XX — Observability layering: injected EventBus vs structural port (2026-06-04)**
>
> **Context.** ADR-013 established that engines accept an injected `EventBus<...>` for in-process observability, layered over `Logger` + OTel traces. That pattern assumes the package can import `@gobing-ai/ts-infra`. Code at or below `ts-infra` in the dependency graph (`ts-utils → ts-runtime → ts-db → ts-infra`) cannot — importing `EventBus` forms a cycle (`ts-runtime → ts-infra → ts-db → ts-runtime`), and `EventBus` is heavyweight (pulls in `Logger`, `JobQueue`, telemetry metrics), so relocating it down is rejected.
>
> **Decision.** Two observability patterns, selected by dependency layer:
> 1. **Above `ts-infra`** — inject `EventBus<XEvents>` directly, plus `getLogger()` and `traceAsync()`; own a typed event map in the package. (rule-engine, dual-workflow-engine, ai-runner.)
> 2. **At/below `ts-infra`** — emit lifecycle events and open spans through zero-dependency **structural ports** (`ProcessEventSink`, `TracerPort`) declared in the local package; a higher layer injects the concrete `EventBus`/`traceAsync`-backed adapter. (ts-runtime `ProcessExecutor`.)
>
> **Selection rule.** If a package can import `EventBus` from `ts-infra` without forming a cycle → pattern 1. Otherwise → pattern 2.
>
> **Consequences.** Event ownership stays at the layer that owns the behavior (`process.*` with the executor; `agent.*` with ai-runner). No cycles. Default ports are no-ops, so existing callers are unaffected. Naming: span event names and `EventBus` event names use the same dotted prefixes (`process.`, `agent.`) to keep traces and bus subscribers aligned. This is additive — logs and traces continue to work without a bus.
