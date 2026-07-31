---
schema_version: 1
name: Route TeamAgentProcess through executor and add logging
status: done
type: task
profile: simple
priority: P1
tags: [ai-runner,team-mode,process-management,observability]
dependencies: ["0018"]
created_at: 2026-06-05T05:25:14.071Z
updated_at: 2026-06-05T05:58:45.000Z
---

## 0019. Route TeamAgentProcess through executor and add logging

### Background

TeamAgentProcess (team mode, net-new — out of scope in task 0016) spawns via raw processSpawner.spawn() and kills via raw process.kill('SIGTERM'/'SIGKILL'), bypassing the executor entirely. This loses process management + observability, and duplicates spawn logic the executor already provides via runStreaming(). It also has no Logger and swallows failures in empty catch {} blocks (stop, send, pipe). Brainstorm F1, F9: docs/plans/2026-06-04-ai-runner-migration-drift-brainstorm.md.


### Requirements

Each item is independently verifiable. "Done" = all acceptance criteria (AC) met with tests + green gate.

1. **Subprocess creation routed through the executor.**
   - AC: `TeamAgentProcess` obtains its `PipeProcess` from `ProcessExecutor.runStreaming()` instead of constructing `BunPipeProcessSpawner` directly.
   - AC: no `BunPipeProcessSpawner`/`processSpawner.spawn()` reference remains in `team-agent-process.ts`.
   - AC: `process.started` / `process.exited` events fire for a team agent's lifecycle (inherited from task 0018's `runStreaming` wiring), observable on the injected `EventBus`.

2. **Logger injected.**
   - AC: `TeamAgentProcess` accepts a `Logger` (default `getLogger('team-agent')`, constructor-overridable).

3. **Silent failures replaced with logged warnings.**
   - AC: the empty `catch {}` in `stop()` (endStdin), `send()`, and `pipe()` each log at `warn` with `{ agentId, op }` context — no swallowed errors.
   - AC: `send()` on a non-running process returns `{ ok: false }` AND emits a warning log.

4. **Lifecycle semantics preserved.**
   - AC: stop sequence remains SIGTERM → 5s timeout → SIGKILL.
   - AC: status transitions (`running` / `stopped` / `errored`) and `getStatus()`/`getPid()`/`getExitCode()` behave as before.

5. **Quality gate.**
   - AC: tests cover spawn-routed-through-executor (events observed), graceful stop, SIGKILL escalation path, and send-on-stopped returns `{ok:false}` with a logged warning.
   - AC: `bun run spur-check` and `bun run build` pass; `git status` shows only intentional changes.


### Q&A



### Design

**Approach**
- Replace the injected `PipeProcessSpawner` with the executor's `runStreaming()`. The `process.*` events + span come from task 0018's wiring inside `runStreaming` — 0019 does NOT add event emission itself, it only routes through the method that already emits.
- Keep the kill/escalation policy (SIGTERM → 5s → SIGKILL) local to `TeamAgentProcess` — that is lifecycle policy the executor doesn't own.

**Dependency caveat (hard)**
- Requires task 0018 to have wired `process.started`/`process.exited` into `runStreaming()` (0018 req #3). If 0018 only wired `run()`, the "events observed" AC here cannot pass — surface and block, do not re-implement emission in this layer.

**Constraints (must NOT)**
- Do NOT change `ProcessExecutor` or the event-map definitions — those are task 0018.
- Do NOT add `agent.*` events here — that is task 0020.
- Do NOT introduce raw `node:*`/`Bun.spawn` usage; process APIs stay in `ts-runtime` per ADR-011.
- Do NOT alter the public `TeamAgentProcess` method surface or lifecycle semantics — observability is additive.

**Dependencies**
- Blocks on: 0018 (ports, sink, `runStreaming` emission).
- Sibling: 0020 (agent.* events / TeamOrchestrator) — independent of this task; both depend only on 0018.


### Solution

Replace the injected PipeProcessSpawner with the executor's runStreaming(). Keep the kill/escalation logic local to TeamAgentProcess (lifecycle policy), but emit through the executor's sink so process.* events fire. Add Logger; every previously-silent catch logs at warn with { agentId, op }. Depends on 0018 (sink/port must exist).


### Plan

1. Replace `TeamAgentProcess` spawner injection with `ProcessExecutor` injection and default to `new ProcessExecutor()`.
2. Route `start()` through `processExecutor.runStreaming()` with a stable `team-agent.<agentId>` label so task 0018 process events/spans are inherited.
3. Inject `Logger` with default `getLogger('team-agent')`.
4. Replace silent `catch {}` paths in `stop()`, `send()`, and `pipe()` with warning logs carrying `{ agentId, op }` and error text where available.
5. Update tests for executor routing, process-event observability, graceful stop, SIGKILL escalation, stopped send warnings, stdin close/write warnings, and pipe warnings.


### Review

PASS

## Verify — 2026-06-05 (re-audit via `/rd3:dev-verify 0019 --auto --fix all --force`)

**Mode:** full (Phase 7 SECU + Phase 8 traceability) · **Channel:** inline (dogfood rule) · **Gate:** `bun run spur-check` → PASS (1134 tests, 0 fail; all 34 spur rules incl. runtime-boundaries, coverage-gate, tsdoc-export). `bun run build` → PASS (8/8 packages).

### Phase 7 — SECU findings

No P1/P2/P3 findings. Security: no surface (subprocess plumbing; no secrets/injection/auth). Correctness: all three previously-empty `catch {}` blocks now log via `warn()`; lifecycle status transitions preserved. ADR-011 boundary clean — `process.kill('SIGTERM'/'SIGKILL')` (`team-agent-process.ts:85,91`) is the executor-provided `PipeProcess.kill()` handle (`const process = this.subprocess`, `:75`), not a raw `node:` API; `rg 'node:child_process|Bun.spawn'` → no matches.

| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | Local var `process` shadows the global `process` | Usability | `team-agent-process.ts:75` | P4/suggestion. Pre-existing from the original file; readability nit only. Out of this task's surgical scope — not auto-renamed. |

**Fix pass (`--fix all`):** no P1/P2/P3 to apply — gate already clean. Finding #1 is P4/pre-existing, deliberately not touched (surgical-change rule).

### Phase 8 — Requirements traceability (5/5 MET)

- [x] **R1** subprocess routed through executor → **MET** | `team-agent-process.ts:57` `processExecutor.runStreaming({ command, args, label })`; no `BunPipeProcessSpawner`/`processSpawner.spawn()` remains. `process.*` events fire (inherited from 0018's `runStreaming` wiring). Test: `team-agent-process.test.ts:74` (`runStreamingCount === 1`), `:103` ("process events are observed when routed through an instrumented executor" — the cross-task contract holds).
- [x] **R2** Logger injected → **MET** | `:30,50` (`getLogger('team-agent')` default, constructor-overridable via `options.logger`).
- [x] **R3** silent failures → logged warnings → **MET** | `warn()` helper (`:151`) emits `{ agentId, op, error }`; called from `stop().endStdin` (`:83`), `send().writeStdin` (`:109`), `pipe()` (`:144`). `send()` on non-running logs + returns `{ok:false}` (`:102`). Tests: `:49` (send-skipped warning), `:74` (write-failure warning), `:141` (stdin-close warning).
- [x] **R4** lifecycle semantics preserved → **MET** | SIGTERM → 5s timeout → SIGKILL (`:85-95`); status `running`/`stopped`/`errored` + `getStatus`/`getPid`/`getExitCode` intact. Test: `:125` ("stop escalates from SIGTERM to SIGKILL after timeout", `killSignals === ['SIGTERM','SIGKILL']`), `:64` (natural non-zero → errored).
- [x] **R5** quality gate → **MET** | spawn-routed/graceful-stop/SIGKILL-escalation/send-on-stopped all tested; spur-check + build green; `git status` shows only intentional changes (1 src + 1 test).

### Verdict: **PASS** (5/5 met)

Implementation matches the refined requirements with no scope drift. The 0018→0019 contract is satisfied: `TeamAgentProcess` routes through `ProcessExecutor.runStreaming()` and `process.*` events are observed end-to-end (test `:103`). One P4/pre-existing readability nit, deliberately untouched. Task 0020 (agent.* events) remains independent and unblocked.


### Testing

2026-06-05T05:58:45-07:00 verification:

- `bun run --cwd packages/ai-runner lint` — PASS.
- `bun run --cwd packages/ai-runner test` — PASS, 74 tests.
- `rg 'BunPipeProcessSpawner|processSpawner|\\.spawn\\(' packages/ai-runner/src/team-agent-process.ts` — PASS, no matches.
- `bun run spur-check` — PASS: root lint/typecheck, 34 pre-check spur rules, 1134 tests, coverage gate, TSDoc export gate.
- `bun run build` — PASS: all 8 packages built.


### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |
| code | `packages/ai-runner/src/team-agent-process.ts` | Codex | 2026-06-05 |
| test | `packages/ai-runner/tests/team-agent-process.test.ts` | Codex | 2026-06-05 |

### References



### History

- Migrated from legacy format (2026-07-31)
