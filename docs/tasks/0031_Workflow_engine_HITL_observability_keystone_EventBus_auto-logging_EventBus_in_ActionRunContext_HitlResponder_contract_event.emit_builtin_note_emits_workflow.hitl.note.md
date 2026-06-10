---
name: "Workflow engine HITL+observability keystone: EventBus auto-logging, EventBus in ActionRunContext, HitlResponder contract, event.emit builtin, note emits workflow.hitl.note"
description: "Workflow engine HITL+observability keystone: EventBus auto-logging, EventBus in ActionRunContext, HitlResponder contract, event.emit builtin, note emits workflow.hitl.note"
status: Done
created_at: 2026-06-10T06:48:42.183Z
updated_at: 2026-06-10T15:37:11.600Z
folder: docs/tasks
type: task
feature-id: ""
impl_progress:
  planning: pending
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

## 0031. "Workflow engine HITL+observability keystone: EventBus auto-logging, EventBus in ActionRunContext, HitlResponder contract, event.emit builtin, note emits workflow.hitl.note"

### Background

**The engine-side keystone** for human-in-the-loop (HITL) interactive workflows and improved
observability. It is consumed by spur-new task **0035** (HITL action runners + responders). Five
related changes land together because they share one root primitive — **making the EventBus reachable
from action runners** — and bundling them avoids three separate releases + three downstream catalog
bumps.

**Layer boundary (consistent with the whole `ts-*` design):** this package owns **generic mechanism +
contracts**; opinionated, I/O-bearing domain actions live downstream in spur. So this task does **NOT**
implement `hitl.confirm`/`select`/`input` (those are spur actions, task 0035). It implements only the
contract and plumbing those actions stand on: the `HitlResponder` interface, the EventBus in
`ActionRunContext`, the generic `event.emit` builtin, and the `note→event` bridge.

**Verified code anchors (current source):**
- `EventBus.emit` (`packages/infra/src/event-bus/event-bus.ts`) is `async`, returns `Promise<void>`,
  constructor takes `{ jobQueue?, lifecycleBus? }` — **no logger** today.
- The workflow engine already hand-pairs emit+log in `RunLifecycle` (`run-lifecycle.ts:124-125,
  132-133, 142+152, 159, 165`) — every `events?.emit(...)` has an adjacent `logger.{debug,info,warn}`.
  So per-event logging exists but is manual and only where someone added it.
- `ActionRunContext` (`dual-workflow-engine/src/types.ts:111-118`) = `{ runId, workdir?, stateOrNodeId,
  vars, env, metadata? }` — **no `events`** today.
- The bus arrives per-run via `WorkflowRunOptions.events` → `StateMachineDriver`/`RunLifecycle`
  (`state-machine.ts:30`). The driver builds `ActionRunContext` in `runActions`
  (`state-machine.ts:158-165`; transition-flow has the mirror).
- `NoteActionRunner.execute` (`host.ts:88-95`) is a pure no-op returning `{ ok:true, data:{message} }`.
- `WorkflowEngineEvents` (`events.ts`) is a **typed** event map, all keys prefixed `workflow.`.
- `createDefaultWorkflowEngineHost` (`host.ts:69`) registers `note`/`shell`/guards as `'builtin'`.

### Requirements

## Requirements

- [x] **R1** — EventBus auto-logging + RunLifecycle dedup → **MET** | Evidence: `packages/infra/src/event-bus/event-bus.ts:34,93-97` (`logger?` ctor + debug `event.emit`); dedup confirmed in `run-lifecycle.ts` (only semantic `'workflow run started/done/failed'` logs remain; `'entered'`/`'transition'` debug lines removed). Test: `event-bus.test.ts:332-353`.
- [x] **R2** — EventBus in `ActionRunContext` (keystone) → **MET** | Evidence: `dual-workflow-engine/src/types.ts:118-119` (`readonly events?`); threaded in both drivers — `state-machine.ts:30,165`, `transition-flow.ts:28,75`. Test: `host.test.ts:265`.
- [x] **R3** — `HitlResponder` contract (types only) → **MET** | Evidence: `dual-workflow-engine/src/hitl.ts:2-29` (`HitlRequestKind`/`HitlRequest`/`HitlAnswer`/`HitlResponder`). No responder/action impl shipped (correct).
- [x] **R4** — `event.emit` builtin → **MET** | Evidence: `host.ts:100-111` (`EventEmitActionRunner`, missing-name → `{ok:false}`, no-bus no-op), registered `'builtin'` at `host.ts:75`. Templated payload via `state-machine.ts:150` `resolveTemplates` before `runAction`. Test: `host.test.ts:265`.
- [x] **R5** — `note` emits `workflow.hitl.note` → **MET** | Evidence: `host.ts:89-98` (`NoteActionRunner` still returns `{ok:true,data:{message}}`, additionally `void context?.events?.emit('workflow.hitl.note', …)`). Test: `host.test.ts`.
- [x] **R6** — Exports + event map → **MET** | Evidence: `src/index.ts:11,14` (Hitl types + `EventEmitActionRunner`); `events.ts:20,22` (`workflow.custom`, `workflow.hitl.note`); README event table `README.md:693-694`.
- [x] **R7** — Tests → **MET** | Evidence: engine `bun test` → 202 pass / 0 fail (was 193+, no regression); infra event-bus → 34 pass / 0 fail. All five new behaviors covered.
- [x] **R8** — Gate + release → **MET** | Evidence: `bun run lint` clean (biome + 8-package typecheck); both packages at `0.3.10`; shipped via commit `62e653c` + release bump `ff943ad`.


### Q&A

**Q1. Why bundle five changes in one task?** They share the root primitive (R2: EventBus in
`ActionRunContext`). `event.emit` (R4), `note→event` (R5), and the downstream HITL actions (0035) all
require it. Bundling = one engine release + one downstream catalog bump instead of three. They are also
all the same layer (engine observability/contract).

**Q2. Why does `event.emit` belong in the engine but `hitl.*` does not?** `event.emit` has **no domain
knowledge and no I/O** — it forwards `{name,payload}` to the bus; pure mechanism, sits beside
`note`/`shell`. `hitl.confirm` encodes domain UX (Yes/No/Cancel semantics, answer→`setVars` shaping,
responder choice) and I/O — opinionated, belongs in spur. Freezing HITL UX in a shared library would
force a ts-libs release per UX tweak.

**Q3. Typed vs. arbitrary custom events?** Typed-namespaced (`workflow.custom { name, payload }`), NOT
raw string-keyed emit. Keeps `WorkflowEngineEvents` a real typed map; subscribers listen to
`workflow.custom` and switch on `name`. A raw `emit(arbitraryString, …)` would defeat the typed map.

**Q4. Per-host vs per-run responder injection?** **Per-host** (operator decision): spur injects
`hitlResponder` into its `hitl.*` action constructors via `registerSpurBuiltins`, exactly like
`agentService`/`ruleService`. So the engine only ships the `HitlResponder` *interface* + `events` in
context; it does NOT add `hitlResponder` to `WorkflowRunOptions`. Keeps engine surface minimal and
matches the established 0032 injection pattern.

**Q5. Does HITL blocking break the driver?** No. The driver does `await host.runAction(...)`
(`state-machine.ts:158`); a responder that resolves when the user answers simply suspends the async
loop. State was persisted by `lifecycle.enter` *before* the action, so an interrupted process leaves a
consistent run record (loses only the in-flight answer). True cross-process suspend/resume is a
separate future concern, not this task.

### Design

- **R1 seam:** `EventBus` constructor gains `logger?: Logger`; `emit` logs `event.emit` at debug before
  dispatch. Dedup `RunLifecycle`: drop `logger.debug('entered'…)`/`('transition'…)` (now covered),
  keep `'workflow run started/done/failed'` (semantic, richer than raw event).
- **R2 seam:** `ActionRunContext.events?`; both drivers pass `options.events` into the context they
  build in `runActions`. Single-line additions at the two context-construction sites.
- **R3:** new `src/hitl.ts` (or fold into `types.ts`) exporting the contract; no logic.
- **R4:** new `EventEmitActionRunner` in `host.ts` beside `NoteActionRunner`; `workflow.custom` added to
  `events.ts`; registered in `createDefaultWorkflowEngineHost`.
- **R5:** `NoteActionRunner.execute` gains a `context.events?.emit('workflow.hitl.note', …)` line;
  `workflow.hitl.note` added to `events.ts`.

### Solution

_Pending design pass — anchors and shapes above are sufficient to implement directly._

### Plan

1. **infra:** `EventBus` constructor `logger?`; log in `emit`; infra tests; (no release yet).
2. **engine R2:** add `events?` to `ActionRunContext`; thread `options.events` in both drivers'
   `runActions` context construction.
3. **engine R3:** export `HitlResponder`/`HitlRequest`/`HitlAnswer`/`HitlRequestKind`.
4. **engine R4:** `workflow.custom` event; `EventEmitActionRunner`; register in default host; templated
   payload via existing `resolveTemplates`.
5. **engine R5:** `workflow.hitl.note` event; `NoteActionRunner` emits it (still no-op success).
6. **engine R1 dedup:** remove redundant manual emit-adjacent logs in `RunLifecycle`.
7. **R6/R7:** exports + README event table; tests for all five behaviors; full engine suite green.
8. **R8:** infra + engine gates; build; **version bump + publish** both; record the published version
   for spur 0035 to pin.


### Review

## Review — 2026-06-10 (dev-verify --force --fix all)

**Status:** 0 actionable findings (PASS)
**Scope:** `ts-infra` event-bus + `ts-dual-workflow-engine` (types, host, events, run-lifecycle, state-machine, transition-flow, hitl, index)
**Mode:** verify (Phase 7 SECU + Phase 8 traceability)
**Channel:** inline
**Gate:** `bun run lint` → pass; engine `bun test` → 202 pass/0 fail; infra event-bus → 34 pass/0 fail

### P1 — Blockers
_None._

### P2 — Warnings
_None._

### P3 — Info
_None._

### P4 — Suggestions
_None._

**SECU notes:** `event.emit` validates non-empty `name` before emit; all event emissions use non-blocking `void context?.events?.emit(...)` (R2/R4/R5 backward-compatible, no-op without a bus); no secrets, injection surface, or swallowed exceptions introduced. EventBus auto-log uses `logger?.debug` (opt-in, backward compatible). Layer boundary respected — no `hitl.*` action or responder implementation leaked into the engine (correctly deferred to spur 0035).

**Verdict:** PASS — all 8 requirements MET, zero P1–P4 findings. No fixes required.


### Testing



### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References

- **Consumed by spur-new 0035** — HITL action runners + responders (downstream; pins this task's
  published version).
- `packages/infra/src/event-bus/event-bus.ts` — `EventBus` (R1 logger injection).
- `packages/dual-workflow-engine/src/{types,host,events,run-lifecycle,state-machine,transition-flow}.ts`
  — R2–R5 anchors.
- ADR-015 (engine three-layer observability: logs / traces / events) — R1/R4/R5 fit this model.


