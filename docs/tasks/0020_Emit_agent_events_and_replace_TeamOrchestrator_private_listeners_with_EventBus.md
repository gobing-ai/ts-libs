---
name: Emit agent events and replace TeamOrchestrator private listeners with EventBus
description: Emit agent events and replace TeamOrchestrator private listeners with EventBus
status: Done
created_at: 2026-06-05T05:25:14.107Z
updated_at: 2026-06-05T06:08:15.000Z
folder: docs/tasks
type: task
feature-id: ""
priority: medium
estimated_hours: 4
dependencies: ["0018"]
tags: ["ai-runner","team-mode","observability","events"]
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: completed
  testing: completed
preset: standard
---

## 0020. Emit agent events and replace TeamOrchestrator private listeners with EventBus

### Background

Two agent.* observability gaps. (F3) AiRunner only logs invocations; it emits no agent.* events on a bus, so programmatic subscribers (dashboards, spur progress) can't observe agent dispatch. (F4) TeamOrchestrator reinvented a private on()/emit() listener map (agent.started, agent.stopped, message.sent) instead of the ts-infra EventBus — inconsistent with ADR-013 and invisible to standard subscribers. ai-runner sits ABOVE ts-infra, so per the ADR-013 Addendum (2026-06-04) it uses the DIRECT injected-EventBus pattern (not the structural port). Brainstorm F3, F4: docs/plans/2026-06-04-ai-runner-migration-drift-brainstorm.md.


### Requirements

Each item is independently verifiable. "Done" = all acceptance criteria (AC) met with tests + green gate.

1. **AiRunner emits `agent.*` invocation events.**
   - AC: `AiRunner` accepts `events?: EventBus<AgentEvents>` (map from task 0018).
   - AC: emits `agent.invoke.start` before each invoke and `agent.invoke.exit` after, carrying `{ agent, operation, label, exitCode, signal, durationMs }`.
   - AC: existing `Logger` behavior is unchanged (events are additive).

2. **TeamOrchestrator uses an injected EventBus internally.**
   - AC: `TeamOrchestrator` accepts `events?: EventBus<AgentEvents>` and emits `agent.started`, `agent.stopped`, `agent.message.sent` through it.
   - AC: the bespoke private `listeners` Map + `TeamEvent`/`TeamListener` types no longer drive emission (see Design for the `on()` back-compat decision).

3. **Events are optional — default path unchanged.**
   - AC: omitting `events` leaves behavior identical (logs/traces still work; no handler dispatch, no throw).

4. **Public-API migration handled (not silently broken).**
   - AC: the documented `TeamOrchestrator.on(...)` surface and its README examples + existing tests are either preserved (thin adapter) or updated in lockstep — no dangling broken references. Decision recorded in Design.

5. **Quality gate.**
   - AC: tests cover — AiRunner emits start+exit on a recording `EventBus`; TeamOrchestrator lifecycle emits the three `agent.*` events; absent bus = no-op.
   - AC: `bun run spur-check` and `bun run build` pass; `git status` shows only intentional changes.


### Q&A



### Design

**Pattern**
- Direct injected-`EventBus` (ai-runner sits ABOVE `ts-infra` — no cycle, no structural port needed; contrast task 0018/0019 which use the port at the runtime layer). Aligns team mode with rule-engine / dual-workflow-engine per ADR-013 Addendum (2026-06-04). `agent.*` prefix per the event taxonomy. `AgentEvents` map is authored in task 0018; this task only emits.

**[DECISION — flag for confirmation] `TeamOrchestrator.on()` is a breaking change.**
- `TeamOrchestrator` is public (`export * from './team-orchestrator'`), documented in README, and exercised by `tests/team-orchestrator.test.ts:129,149` via `orchestrator.on('agent.started', …)`. No cross-package consumers found in this workspace (blast radius contained to ai-runner's own tests + README).
- **Option A (recommended): keep a thin `on()` adapter over the injected bus.** Preserves the documented API; internal storage becomes the `EventBus`. Lowest blast radius, no test/README churn. Slightly more surface to maintain.
- **Option B: hard-remove `on()`/`emit()`; update tests + README in lockstep.** Cleaner single-path API, honest with ADR-013, but a breaking change for any external subscriber and forces a test rewrite.
- Default if unconfirmed: **A** (team mode is recent but already has a documented public `on()`; back-compat is cheap). Revisit if the operator wants the stricter single-bus surface.

**Constraints (must NOT)**
- Do NOT define `AgentEvents` here — it is authored in task 0018 (declaration). This task imports + emits.
- Do NOT touch `ProcessExecutor`, the ports, or `process.*` events (tasks 0018/0019).
- Do NOT make `events` required — optional injection only, default path unchanged.

**Dependencies**
- Blocks on: 0018 (`AgentEvents` map + `EventBus` availability via ai-runner's existing `ts-infra` dep).
- Sibling: 0019 (independent; both depend only on 0018). 0019 and 0020 may proceed in parallel after 0018.


### Solution

Direct injected-EventBus pattern (ai-runner is above ts-infra — no cycle, no port needed). agent.* prefix per task. AgentEvents map authored in task 0018. TeamOrchestrator drops its hand-rolled emitter for EventBus<AgentEvents>, aligning team mode with rule-engine/dual-workflow-engine. Depends on 0018 (AgentEvents map).


### Plan

1. Add `events?: EventBus<AgentEvents>` to `AiRunnerOptions` and emit `agent.invoke.start` / `agent.invoke.exit` around each invocation without changing logging behavior.
2. Add `events?: EventBus<AgentEvents>` to `TeamOrchestratorOptions`, default to an internal `EventBus`, and route lifecycle emission through the bus.
3. Preserve `TeamOrchestrator.on()` as a thin adapter over the bus for `agent.*` event names; remove the private listener map and custom listener types.
4. Emit `agent.started`, `agent.stopped`, and `agent.message.sent` from orchestrator lifecycle/message flows.
5. Update tests for injected-bus behavior, no-events default behavior, and the preserved `on()` adapter.


### Review

PASS

## Verify — 2026-06-05 (re-audit via `/rd3:dev-verify 0020 --auto --fix all --force`)

**Mode:** full (Phase 7 SECU + Phase 8 traceability) · **Channel:** inline (dogfood rule) · **Gate:** `bun run spur-check` → PASS (1136 tests, 0 fail; all 34 spur rules incl. runtime-boundaries, coverage-gate, tsdoc-export). `bun run build` → PASS (8/8 packages).

### Phase 7 — SECU findings

No P1/P2/P3/P4 findings. Security: `agent.*` payloads carry only `{ agent, operation, label }` / `{ agentId, agentType, pid, exitCode, ok }` — no secrets, no command bodies, no over-logging. Correctness: all emits are optional-chained / `void`-fired (additive, never throw into business logic); logger behavior unchanged. Maintainability: bespoke `TeamEvent`/`TeamListener` types + private `listeners` Map fully removed (`rg` → no matches); replaced by injected `EventBus<AgentEvents>`, aligning team mode with rule-engine / dual-workflow-engine. ADR-013 Addendum pattern (direct injected bus, ai-runner is above ts-infra) correctly applied.

### Decision resolution — `TeamOrchestrator.on()` (flagged at refine)

Implemented as **Option A (recommended)**: `on<K extends keyof AgentEvents>()` kept as a thin typed adapter over the injected bus (`team-orchestrator.ts:125-128`, `on` → `events.on`, returns `() => events.off`). The documented public API is preserved — **non-breaking**. README team-mode example uses no `.on()` call, so no doc reference went stale; the only README change is a `PipeProcessSpawner → PipeProcess` correction (carryover from 0019). Both subscription paths tested: direct bus (`team-orchestrator.test.ts:120-124`) and `on()` adapter (`:137,158`).

### Phase 8 — Requirements traceability (5/5 MET)

- [x] **R1** AiRunner emits `agent.*` invocation events → **MET** | `ai-runner.ts:49` `events?: EventBus<AgentEvents>`; `:134` `agent.invoke.start` before run, `:151` `agent.invoke.exit` after (with `agent, operation, label, exitCode, signal?, durationMs`). Logger untouched. Test: `ai-runner.test.ts:115` ("emits agent invocation events without changing logger behavior").
- [x] **R2** TeamOrchestrator uses injected EventBus → **MET** | `team-orchestrator.ts:26,34` (`events: EventBus<AgentEvents>`); emits `agent.started` (`:77`), `agent.stopped` (`:90`), `agent.message.sent` (`:102`). Bespoke `listeners`/`TeamEvent`/`TeamListener` removed. Tests: `team-orchestrator.test.ts:120-124` (all three on the bus).
- [x] **R3** events optional, default path unchanged → **MET** | AiRunner `this.events?.emit` (optional-chained, `:134,151`); TeamOrchestrator defaults to a fresh `new EventBus<AgentEvents>()` when none injected (`:34`), so omission is a no-op sink. Full suite green with and without injected bus.
- [x] **R4** public-API migration handled (not silently broken) → **MET** | Option A: `on()` preserved as typed adapter (`:125`). README example still valid (no `.on()` reference to break); tests updated in lockstep. No dangling references.
- [x] **R5** quality gate → **MET** | AiRunner start+exit on recording bus, TeamOrchestrator three `agent.*` events, absent-bus no-op all tested; spur-check + build green; `git status` shows only intentional changes (3 src + 2 test + README).

### Verdict: **PASS** (5/5 met)

Implementation matches the refined requirements with no scope drift. The flagged `on()` decision resolved cleanly via Option A (non-breaking adapter). No SECU findings — nothing to fix under `--fix all`. The ai-runner observability set (0018 ports + 0019 process routing + 0020 agent events) is now complete and consistent with ADR-013.


### Testing

2026-06-05T06:08:15-07:00 verification:

- `bun run --cwd packages/ai-runner lint` — PASS.
- `bun run --cwd packages/ai-runner test` — PASS, 76 tests.
- `rg 'listeners|TeamEvent|TeamListener|message\\.sent|private emit\\(' packages/ai-runner/src/team-orchestrator.ts` — PASS, no private listener map/types remain; only `agent.message.sent` emission remains.
- `bun run spur-check` — PASS: root lint/typecheck, 34 pre-check spur rules, 1136 tests, coverage gate, TSDoc export gate.
- `bun run build` — PASS: all 8 packages built.


### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |
| code | `packages/ai-runner/src/ai-runner.ts` | Codex | 2026-06-05 |
| code | `packages/ai-runner/src/team-orchestrator.ts` | Codex | 2026-06-05 |
| docs | `packages/ai-runner/README.md` | Codex | 2026-06-05 |
| test | `packages/ai-runner/tests/ai-runner.test.ts` | Codex | 2026-06-05 |
| test | `packages/ai-runner/tests/team-orchestrator.test.ts` | Codex | 2026-06-05 |

### References

