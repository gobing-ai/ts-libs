---
name: "Workflow engine HITL+observability keystone: EventBus auto-logging, EventBus in ActionRunContext, HitlResponder contract, event.emit builtin, note emits workflow.hitl.note"
description: "Workflow engine HITL+observability keystone: EventBus auto-logging, EventBus in ActionRunContext, HitlResponder contract, event.emit builtin, note emits workflow.hitl.note"
status: Backlog
created_at: 2026-06-10T06:48:42.183Z
updated_at: 2026-06-10T06:48:42.183Z
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

**R1 — EventBus auto-logging (A1).** Add an optional `logger?: Logger` to the `EventBus` constructor
(`@gobing-ai/ts-infra`). On every `emit`, before dispatch, log at `debug`:
`logger?.debug('event.emit', { event: String(event), syncHandlers, asyncHandlers })`. Level control is
left to logger configuration (no per-emit level option). Absent logger = today's behavior (backward
compatible). **Then remove the now-redundant manual emit-adjacent `logger.debug('entered'…)` /
`'transition'…` lines in `RunLifecycle`** that only duplicate what auto-logging now covers — keep the
semantic lifecycle logs (`'workflow run started/done/failed'`) which carry more than the raw event.
Document in the dedup which logs stay vs. go (avoid double-logging).

**R2 — EventBus in `ActionRunContext` (the keystone primitive).** Add `readonly events?:
EventBus<WorkflowEngineEvents>` to `ActionRunContext`. Thread `options.events` (already in the driver)
into the context built in `runActions` for **both** drivers (state-machine + transition-flow). Action
runners can then emit. Backward compatible (optional; absent on hosts run without a bus).

**R3 — `HitlResponder` contract (types only; no implementation).** Export from this package:
```ts
export type HitlRequestKind = 'confirm' | 'select' | 'input';
export interface HitlRequest {
  kind: HitlRequestKind;
  prompt: string;
  /** select: the choices; confirm: optional labels; input: ignored. */
  options?: string[];
  /** echoed back for correlation. */
  runId: string;
  node: string;
}
export interface HitlAnswer {
  /** confirm → 'yes'|'no'|'cancel'; select → chosen option; input → free text. */
  value: string;
  /** convenience: true when the user cancelled (confirm 'cancel'). */
  cancelled?: boolean;
}
export interface HitlResponder {
  respond(request: HitlRequest): Promise<HitlAnswer>;
}
```
**No responder implementation ships here** — spur (0035) provides CLI/headless responders. **No
`hitl.*` action ships here** — those are spur actions. The responder is injected **per-host by spur via
its action constructors** (decision: per-host, matching how `agentService`/`ruleService` are injected
in `registerSpurBuiltins`), so this package does NOT add `hitlResponder` to `WorkflowRunOptions`.

**R4 — `event.emit` builtin action (Q2).** Register a generic `EventEmitActionRunner` (`kind:
'event.emit'`, origin `'builtin'`) in `createDefaultWorkflowEngineHost`. It emits a **typed, namespaced
custom event** (option (a) — keep the event map honest):
- New event in `WorkflowEngineEvents`: `'workflow.custom': (data: { name: string; payload:
  Record<string, unknown> }) => void`.
- Options: `name` (string, required), `payload` (object, optional). `payload` values are
  `${...}`-templated by the driver before `execute` (it flows through `resolveTemplates` like every
  action's options), so a node can emit run state: `{ name: 'checkpoint', payload: { task:
  '${vars.taskId}' } }`.
- `execute` emits via `context.events?.emit('workflow.custom', { name, payload })` (no-op if no bus)
  and returns `{ ok: true, data: { name, payload } }`. Never blocks. Missing `name` → `{ ok:false }`.

**R5 — `note` emits `workflow.hitl.note` (B1).** Keep `NoteActionRunner` non-blocking and backward
compatible (still returns `{ ok:true, data:{message} }`). Additionally emit
`'workflow.hitl.note': (data: { node: string; message: string }) => void` (new typed event) via
`context.events?.emit(...)`. The engine still does NOT print the note (no TTY) — downstream subscribers
(spur CLI) decide to display/notify. `note` reaches the bus through R2's context.events.

**R6 — Exports + event map.** Export `HitlRequest`/`HitlAnswer`/`HitlResponder`/`HitlRequestKind` and
`EventEmitActionRunner` from `src/index.ts`. Add `workflow.custom` and `workflow.hitl.note` to
`WorkflowEngineEvents` (`events.ts`) and document both in the engine README's event table.

**R7 — Tests.** EventBus auto-log (logger called on emit; silent when absent). `ActionRunContext.events`
threaded in both drivers (an action receives a working bus). `event.emit` emits `workflow.custom` with
templated payload; no-bus no-op; missing-name fail. `note` emits `workflow.hitl.note` while staying a
no-op success. No regression in existing 193+ engine tests.

**R8 — Gate + release.** Engine + infra own gates green; build; **version bump + publish** (this is the
artifact spur 0035 consumes by semver). Update engine README event table + RunLifecycle dedup note.

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


