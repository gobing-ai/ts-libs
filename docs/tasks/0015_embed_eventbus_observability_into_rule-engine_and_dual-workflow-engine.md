---
schema_version: 1
name: embed_eventbus_observability_into_rule-engine_and_dual-workflow-engine
status: done
type: task
profile: complex
priority: P2
tags: [rule-engine,dual-workflow-engine,observability,eventbus,ts-infra,dx,additive]
dependencies: [ADR-006,ADR-013,task-0013,task-0014]
created_at: 2026-06-04T23:36:23.179Z
updated_at: 2026-06-05T00:11:54Z
---

## 0015. embed_eventbus_observability_into_rule-engine_and_dual-workflow-engine

### Background

Observability audit (2026-06-04) found a stark asymmetry. dual-workflow-engine (post task 0013/0014) has structured logging (getLogger('workflow') run-scoped via child()), OTel tracing (traceAsync('workflow.run') + addSpanEvent per step), and depends on ts-infra. rule-engine has NOTHING: no logger, no tracing, no ts-infra dep (only ts-runtime + ts-ai-runner), and RuleEngine.evaluate() is a silent black box that returns nothing until all rules finish. This silence has a concrete cost: spur works around it by re-entering the engine once per rule (rule-service.ts:344 engine.evaluate([singleRule]) in a loop) purely to stream per-rule progress — paying per-call setup N times. Neither engine offers a programmatic SUBSCRIPTION layer: consumers (IDE plugins, CI dashboards, spur progress bars) can only scrape logs or attach an OTel collector; they cannot subscribe to evaluation/run events. The repo already ships a typed EventBus (packages/infra/src/event-bus) — the right primitive for in-process pub/sub observability. DESIGN PRINCIPLE: logs (getLogger, human/file debug), traces (traceAsync, distributed perf), and events (EventBus, programmatic subscription) are THREE distinct consumers — EventBus is ADDITIVE, not a replacement for the logger/tracer the workflow engine already has. Engine-local typed event maps + shared injection pattern = conceptual symmetry without code coupling (same principle as task 0014's severity alignment). All rule-engine events prefixed 'rule.'; all workflow events prefixed 'workflow.' so streams are trivially filterable and collision-free on a shared bus.


### Requirements

**Part A — rule-engine observability** (it has none today)

- **R-A1**: Add `@gobing-ai/ts-infra` `workspace:*` dep + tsconfig path alias (ADR-002/004). → **Done when**: `bun install` links it, `tsc --noEmit` resolves it, and there is no dependency cycle (`ts-infra → ts-db` only).
- **R-A2**: Structured logging via `getLogger('rule-engine')` over an evaluation run (run start/done + per-rule debug). → **Done when**: an injected/spied logger receives a run-start line, a per-rule debug line, and a run-done line for a 2-rule evaluation.
- **R-A3**: Wrap `evaluate`/`evaluateWithFixes` in `traceAsync('rule.run')` with per-rule span events. → **Done when**: the run executes inside an active span (no-op when no provider, per ADR-009); an exception sets span error status and re-throws (existing behavior preserved).
- **R-A4**: Define typed `RuleEngineEvents` EventMap; accept an optional `EventBus` via `new RuleEngine({ events })`. → **Done when**: omitting `events` adds zero observable overhead (no emit calls / no handler invocation — proven by a no-bus test); supplying one routes events to subscribers.
- **R-A5**: Emit in the `engine.ts:82` loop — `rule.run.start` `{rules,total}`; `rule.eval.start` `{ruleId,index,total}`; `rule.eval.done` `{ruleId,findings,durationMs}`; `rule.eval.error` `{ruleId,error}`; `rule.run.done` `{rules,findings,durationMs,stoppedEarly}`. → **Done when**: a subscriber on a 3-rule run receives the events in order (1× run.start, 3× eval.start/done pairs, 1× run.done) with correct index/total/findings counts; `stoppedEarly` is `true` when `stopOnFirst` short-circuits.
- **R-A6**: `rule.eval.error` is emitted when an evaluator throws (`engine.ts:91`) — distinct from a violation finding. → **Done when**: a throwing evaluator emits `rule.eval.error` AND still produces its `kind:'error'` finding; a normal violation emits NO `rule.eval.error`.
- **R-A7**: Replace the hand-rolled `{ warn }` structural logger in `config/extensions.ts` with ts-infra `Pick<Logger,'warn'>`, mirroring the workflow engine's prior fix. → **Done when**: extension-override warnings flow through the ts-infra `Logger` type; existing extension tests pass unmodified.

**Part B — workflow-engine events** (logging/tracing already done in 0013)

- **R-B1**: Define typed `WorkflowEngineEvents` EventMap, all `workflow.` prefixed, names aligned with existing `addSpanEvent` names. → **Done when**: event names match the span-event vocabulary already in `RunLifecycle` (one vocabulary across the trace + event layers).
- **R-B2**: Add an optional `EventBus` to `RunLifecycle` (the single emit seam); emit alongside existing logger/`addSpanEvent` calls — `workflow.run.started/done/failed`, `workflow.node.enter`, `workflow.node.transition`, `workflow.action.failed_continue`. → **Done when**: a subscriber receives each run-lifecycle event with the same payload the logger/span already carry; omitting the bus changes nothing (zero-overhead).
- **R-B3**: Add action-level granularity — `workflow.action.start`/`workflow.action.done` `{node,kind,durationMs,ok}` events + matching span events (currently spans stop at node level). → **Done when**: a node with an action emits start+done with a measured `durationMs` and the action's `ok`; a node without an action emits neither.

**Cross-cutting**

- **R-C1**: Both engines use the SAME injection pattern (`options.events?: EventBus<...>`) with ENGINE-LOCAL event maps — no shared event-map module. → **Done when**: `RuleEngineEvents` and `WorkflowEngineEvents` live in their own packages; no cross-engine import; injection shape identical.
- **R-C2**: Keep logs + traces; EventBus is ADDITIVE. → **Done when**: the workflow logger/tracer calls remain; no `getLogger`/`traceAsync`/`addSpanEvent` is removed or replaced by an emit.
- **R-C3**: ADR entry recording the three-layer model (logs/traces/events), the prefixed-event convention, and the per-engine-map/shared-pattern symmetry. → **Done when**: `docs/00_ADR.md` carries the dated entry referencing both engines.
- **R-C4**: Tests — rule-engine (emission order, zero-overhead-when-absent, `eval.error` vs finding); workflow (emission + action.start/done timing). → **Done when**: new tests under each package's `tests/`; coverage gate (≥90%) stays green.
- **R-C5**: Full gate green + lockstep-publishable. → **Done when**: `bun run spur-check` + `bun run build` pass; both packages releasable in one lockstep bump (unblocks spur-new#0018).
- **R-C6**: Additive-only. → **Done when**: no existing config, caller, or test is edited to keep passing (new tests only); old workflow/rule configs behave identically.


### Q&A

_Refined via `rd3:dev-refine 0015 --auto` (synthesis-only, no interactive Q&A). Decisions derived from existing Background/Solution:_

- **Q: Requirements format?** → Reformatted the dense single-paragraph requirements into a numbered list (R-A1..7, R-B1..3, R-C1..6) with a verifiable **"Done when"** acceptance clause per item. Split the original R-A5 (emit + error-distinction) into R-A5 (emission) + R-A6 (eval.error vs finding) for independent testability; renumbered the extensions-logger swap to R-A7.
- **Q: Constraints section?** → The scaffold has no `### Constraints` heading and the `tasks` CLI only writes existing sections; constraints/invariants were synthesized into the **Design** section (correct CLI-writable home), alongside a three-layer model table and engine-local event-map payload sketches.
- **Q: Preset?** → `complex` confirmed (already set): 2 packages, 6+ files, a new cross-package dep edge (rule-engine→ts-infra), an ADR entry, and a downstream release-gated consumer. Not `research` — the pattern is proven (workflow engine did it in 0013).
- **Q: Acceptance criteria depth?** → Each requirement now states an observable pass condition (subscriber receives N events in order; no-bus = zero overhead; eval.error ≠ finding; durationMs measured; old tests unmodified).
- **Open (deferred to design phase, non-blocking):** EventBus injection site on `RunLifecycle` (recommend existing `RunLifecycleDeps.events?`); await-vs-`void` emit in the hot loop (recommend `void` fire-and-forget, matching `event-bus.ts:202`).


### Design

**Three-layer observability model** (the load-bearing design decision — do NOT collapse):

| Layer | Tool | Consumer | Status |
|-------|------|----------|--------|
| Logs | `getLogger(category)` | human / file debugging | workflow ✅, rule-engine ❌ (add) |
| Traces | `traceAsync` + `addSpanEvent` | distributed perf correlation (OTel) | workflow ✅, rule-engine ❌ (add) |
| Events | `EventBus<EngineEvents>` | programmatic in-process subscription (UI progress, CI dashboards, spur) | both ❌ (add — the genuinely missing layer) |

EventBus is **additive**. It does NOT replace the logger/tracer the workflow engine already has (R-C2). A consumer who wants a progress bar subscribes to events; a consumer who wants traces attaches an OTel collector; both work independently.

**Design constraints / invariants:**

- **Engine-local event maps, shared injection pattern.** `RuleEngineEvents` and `WorkflowEngineEvents` are each package-private; both engines accept `options.events?: EventBus<...>`. Conceptual symmetry, zero code coupling — the same principle as task 0014's severity alignment (same shape, no shared module).
- **Prefixed events.** All rule-engine events start `rule.`; all workflow events start `workflow.` — so a consumer subscribing to both on one bus can filter by prefix and never collide.
- **Zero-overhead default.** No `events` injected → no emit / no handler cost (EventBus emit with 0 handlers is a documented no-op, `event-bus.ts:154`). No user is forced to adopt observability infra.
- **`rule.eval.error` ≠ violation finding.** A thrown evaluator (`engine.ts:91`) emits `rule.eval.error` AND still yields its `kind:'error'` finding — the event is the crash signal, the finding is the verdict input. Don't conflate.
- **Boundaries.** rule-engine gains `ts-infra` (new direct dep per ADR-012; no cycle, `ts-infra → ts-db` only); no `node:*` outside ts-runtime (ADR-011); no new top-level dep beyond ts-infra.
- **Additive-only.** Old configs/callers/tests unchanged; new tests only.
- **Gate non-negotiable.** `bun run spur-check` + `bun run build` must pass; no `--no-verify`, no gate-silencing `biome-ignore`, no `.skip`.

**Event payload sketch (engine-local maps):**
```
RuleEngineEvents = {
  'rule.run.start':  (d: { rules: number; total: number }) => void;
  'rule.eval.start': (d: { ruleId: string; index: number; total: number }) => void;
  'rule.eval.done':  (d: { ruleId: string; findings: number; durationMs: number }) => void;
  'rule.eval.error': (d: { ruleId: string; error: string }) => void;
  'rule.run.done':   (d: { rules: number; findings: number; durationMs: number; stoppedEarly: boolean }) => void;
}
WorkflowEngineEvents = {
  'workflow.run.started'|'workflow.run.done'|'workflow.run.failed': (d: {...}) => void;
  'workflow.node.enter'|'workflow.node.transition':                  (d: {...}) => void;
  'workflow.action.start'|'workflow.action.done':                    (d: { node; kind; durationMs; ok }) => void;
  'workflow.action.failed_continue':                                 (d: {...}) => void;
}
```

**Open (decide at implementation, non-blocking):** whether `RunLifecycle` takes the `EventBus` via its existing `deps` object or a new field (recommend: existing `RunLifecycleDeps`, optional `events?`); whether `EventBus.emit` is awaited in the loop (async) or fire-and-forget `void` (recommend: `void` to keep the hot loop non-blocking, matching how `event-bus.ts:202` self-emits lifecycle events).


### Solution

Part A (~50 src + ~80 test, Medium): new ts-infra dep + alias; RuleEngineEvents map; optional EventBus in RuleEngine options; getLogger + traceAsync + emit woven into the engine.ts:82 loop; swap extensions.ts structural logger. Part B (~30 src + ~60 test, Low-Medium): WorkflowEngineEvents map; optional bus on RunLifecycle emitted alongside existing signals; new action.start/done span+event pair. Cross: one ADR entry (three-layer model + prefix convention), zero-overhead default proven by a no-bus test, lockstep release. KEEP logs+traces — EventBus is the new subscription layer, not a replacement. This directly removes spur's N-call per-rule workaround (downstream task).


### Plan

- Add engine-local typed event maps for rule-engine and dual-workflow-engine, exported from each package without introducing a shared cross-engine event module.
- Add `@gobing-ai/ts-infra` as a direct rule-engine dependency and keep TypeScript source aliases aligned with the transitive source closure (`ts-infra` → `ts-db`).
- Instrument `RuleEngine.evaluateWithFixes` with `getLogger('rule-engine')`, `traceAsync('rule.run')`, per-rule span events, and optional `EventBus<RuleEngineEvents>` emission.
- Route `WorkflowRunOptions.events` into `RunLifecycle`, emit workflow run/node/action-failure events beside existing logs/traces, and add driver-level action start/done events.
- Record the three-layer logs/traces/events decision in `docs/00_ADR.md`.
- Add targeted tests for rule event order, stop-on-first metadata, evaluator error events, no-bus behavior, workflow lifecycle events, and workflow action events.

### Review

Verdict: **PASS**.

SECU review completed locally after implementation. Requirements R-A1..R-A7, R-B1..R-B3, and R-C1..R-C6 are satisfied:

- Security/boundaries: no secrets, no new platform API usage, no drizzle import outside `ts-db`; rule-engine depends directly only on `ts-infra` and uses `ts-db` only as a tsconfig source alias for the `ts-infra` transitive closure.
- Error handling: evaluator exceptions still become `kind: 'error'` findings and additionally emit `rule.eval.error`; unhandled exceptions remain inside `traceAsync` so span error status/rethrow behavior is preserved.
- Compatibility: event buses are optional; existing callers/configs remain valid; logs/traces are retained and events are additive.
- Maintainability: event maps remain engine-local with identical injection shape and prefixed names.

### Testing

2026-06-05T00:11:54Z:

- `bun run lint` — PASS.
- `bun run test` — PASS, 1095 tests before event-map test additions, 99.16% funcs / 99.27% lines.
- `bun run spur-check` — PASS, 1097 tests, pre/post spur rules clean, 99.16% funcs / 99.27% lines.
- `bun run build` — PASS for all packages.

Focused checks:

- `bun test packages/rule-engine/tests/engine.test.ts packages/dual-workflow-engine/tests/run-lifecycle.test.ts packages/dual-workflow-engine/tests/transition-flow.test.ts` — all targeted assertions PASS; focused run exits nonzero only because repository coverage thresholds are global and unrelated packages are under-covered in focused selection.

### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |
| ADR | `docs/00_ADR.md` | codex | 2026-06-05 |
| Source | `packages/rule-engine/src/events.ts` | codex | 2026-06-05 |
| Source | `packages/rule-engine/src/engine.ts` | codex | 2026-06-05 |
| Source | `packages/dual-workflow-engine/src/events.ts` | codex | 2026-06-05 |
| Source | `packages/dual-workflow-engine/src/run-lifecycle.ts` | codex | 2026-06-05 |
| Tests | `packages/rule-engine/tests/engine.test.ts` | codex | 2026-06-05 |
| Tests | `packages/dual-workflow-engine/tests/run-lifecycle.test.ts` | codex | 2026-06-05 |
| Tests | `packages/dual-workflow-engine/tests/transition-flow.test.ts` | codex | 2026-06-05 |

### References


### History

- Migrated from legacy format (2026-07-31)
