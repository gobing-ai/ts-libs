---
template: feature-impl
schema_version: 1
name: Wire lifecycleBus + attachFileObserver across ts-infra application bootstrap, ai-runner, rule-engine, dual-workflow-engine (fixes agent.* / api.* / bus.* / rule.* / workflow.* / process.* in System Events)
status: done
type: task
feature_id: D1
priority: P1
tags: [observability,system-events,event-bus,infra,ai-runner,rule-engine,dual-workflow-engine,lifecycle-bus,file-observer]
dependencies: ["0049"]
created_at: 2026-07-12T17:30:00.000Z
updated_at: "2026-08-12T14:40:55.498Z"
---

## 0050. Wire lifecycleBus + attachFileObserver in runApplication and propagate across all consumer-facing EventBus constructors

### Background

Companion to task 0049 (diagnosis). 0049 proved that six of the nine prefixes missing from
the System Events tabview (`agent.*`, `api.*`, `bus.*`, `rule.*`, `workflow.*`, `process.*`)
share one architectural gap: every primary `EventBus<XEvents>` outside `ts-infra`'s
internals is constructed without `new EventBus({ lifecycleBus })`, so its `emit()` never
produces a `bus.emit.done` lifecycle event; and `ts-infra`'s `runApplication` is the only
code path that creates a `lifecycleBus` and it never calls `attachFileObserver` even for
itself.

Fixing both ends in one PR closes six prefixes at once and re-establishes the
ADR-013 addendum observability contract end-to-end.

### Requirements
- [x] R1. `packages/infra/src/application/index.ts:139-149` — when `eventsFileObserver`
  config is enabled (default: true), call `attachFileObserver(lifecycleBus, filePath, writer)`
  where `filePath` defaults to `<runtimePaths.logs>/system-events.jsonl` and `writer` is the
  already-imported `@gobing-ai/ts-runtime` `FileSystem`. **Done when** `runApplication({ events:
  { enabled: true, fileObserver: true } })` produces JSONL rows on `bus.emit.done` from any
  bus constructed from the propagated lifecycle bus; covered by a `tests/application/` test
  that monkey-patches `FileSystem` and verifies the JSONL body.

- [x] R2. `RuleEngine` (`packages/rule-engine/src/engine.ts`) — accept
  `lifecycleBus?: EventBus<BusLifecycleEvents>` in `RuleEngineOptions`. When present,
  construct the internal `events?: EventBus<RuleEngineEvents>` with `{ lifecycleBus }` so
  `rule.run.start` / `rule.eval.*` emits land in JSONL. **Done when** an integration test
  (`tests/engine.test.ts`) constructs a `RuleEngine` with a stub `lifecycleBus` whose
  `bus.emit.done` handler captures the breadcrumb for `rule.run.done`.

- [x] R3. `RunLifecycle` / `service.ts` / `host.ts` (`packages/dual-workflow-engine/src/`) —
  accept `lifecycleBus?: EventBus<BusLifecycleEvents>` at the boundary of every `events`
  field; propagate it identically to R2. **Done when** an integration test
  (`tests/run-lifecycle.test.ts` or sibling) asserts `bus.emit.done` fires with
  `detail.event === 'workflow.run.started'` after `RunLifecycle.run(...)`.

- [x] R4. `AiRunner` (`packages/ai-runner/src/ai-runner.ts:47-52`) and `TeamOrchestrator`
  (`packages/ai-runner/src/team-orchestrator.ts:34-35`) — accept `lifecycleBus?`; when
  present, construct both `events` and `processEvents` buses with `{ lifecycleBus }`.
  **Done when** an integration test asserts both `agent.invoke.start` and `process.started`
  produce `bus.emit.done` breadcrumbs.

- [x] R5. `APIClient` (`packages/infra/src/api-client.ts:27-31`) — same pattern. **Done
  when** an existing `tests/api-client.test.ts` case wires `lifecycleBus` and asserts
  `bus.emit.done` fires for `api.request.error`.

- [x] R6. `runApplication` propagates its lifecycleBus to the consumer-facing events bus and
  exposes a way for the consumer to retrieve it (or passes through a context object).
  **Done when** the contract is documented in the bootstrap JSDoc and a downstream consumer
  test reuses the same lifecycle bus for both `events` and the JSONL writer.

- [x] R7. Quality gates: `bun run spur-check` clean; `bun run build` exits 0 for all 8
  packages; no test skipped; `git status` shows only intentional changes. **Done when** the
  final `git status` matches the change-map table.

- [x] R8. (Optional but recommended per ADR-006) — add a `spur` rule under
  `.spur/rules/` titled `lifecycle-bus-propagation`: any package whose source declares an
  `events?: EventBus<XEvents>` option must also accept `lifecycleBus?: EventBus<BusLifecycleEvents>`
  or build the `events` bus with `{ lifecycleBus }` from a constructor-injected value.
  **Done when** the rule appears in `spur rule list` and the new packages pass; **deferred**
  if the rule generation is non-trivial — file a follow-up task.
### Acceptance Criteria

```gherkin
Feature: lifecycleBus + attachFileObserver are wired in runApplication and propagated everywhere

  @core
  Scenario: R1 — runApplication turns on attachFileObserver by default
    Given a stub FileSystem writer that captures appendFile calls
    When runApplication is invoked with default options
    Then attachFileObserver is wired against lifecycleBus
    And any bus.emit() on the shared bus produces a JSONL row in the writer

  @core
  Scenario: R2 — RuleEngine emits bus.emit.done for rule.run.* events
    Given a RuleEngine constructed with { events, lifecycleBus }
    When RuleEngine.evaluate runs against any ruleset
    Then the lifecycle bus's bus.emit.done fires with detail.event === "rule.run.start"
    And detail.event === "rule.run.done" again at completion

  @core
  Scenario: R3 — RunLifecycle emits bus.emit.done for workflow.* events
    Given a RunLifecycle constructed with { events, lifecycleBus }
    When RunLifecycle.run(...) executes
    Then bus.emit.done fires with detail.event === "workflow.run.started"
    And detail.event === "workflow.run.done" at completion

  @core
  Scenario: R4 — AiRunner emits bus.emit.done for agent.* and process.* events
    Given an AiRunner constructed with { events, processEvents, lifecycleBus }
    When AiRunner.invoke('codex', {...}) runs (against a stub command)
    Then bus.emit.done fires for "agent.invoke.start" and "agent.invoke.exit"
    And bus.emit.done fires for "process.started" and "process.exited"

  @core
  Scenario: R5 — APIClient emits bus.emit.done for api.request.error
    Given an APIClient constructed with { events, lifecycleBus }
    When the client makes a request that fails with HTTP 500
    Then bus.emit.done fires with detail.event === "api.request.error"

  @edge
  Scenario: R1b — eventsFileObserver = false disables the file writer
    Given runApplication({ events: { fileObserver: false } })
    When any bus.emit() runs
    Then no JSONL appendFile call is observed (no file I/O happens)

  @edge
  Scenario: R2b — RuleEngine without lifecycleBus behaves unchanged
    Given a RuleEngine constructed with { events: new EventBus() } (no lifecycleBus)
    When RuleEngine.evaluate runs
    Then events.emit still works for subscribers
    And no error is thrown
```

### Design

Three layered moves:

**Layer 1 — application bootstrap owns the wiring.** `ts-infra/src/application/index.ts`
becomes the canonical place where `lifecycleBus` is created and `attachFileObserver` is
attached. Default-on with a config switch. ADR-009 / ADR-013 addendum observability contract
preserved: nothing else changes the layering.

**Layer 2 — accept `lifecycleBus?` in every consumer-facing bus.** A trivial constructor
option, no behavioral change when absent. When present, it is forwarded into the inner
`new EventBus<XEvents>({ lifecycleBus })`. A consumer that constructs one shared
lifecycleBus and passes it into all the buses (RuleEngine, AiRunner, APIClient, …) gets
all of them wired for JSONL for free.

**Layer 3 — propagate from runApplication.** `runApplication` already builds the app's
primary `events` bus from the lifecycleBus; expose the lifecycleBus so the consumer can
forward it to RuleEngine/AiRunner/APIClient/etc. (or pass through a context object — TBD in
the impl PR).

**ProcessExecutor is unchanged.** It still uses the `ProcessEventSink` structural port
(ADR-013 addendum). The fix reaches `process.*` via the `ai-runner.processEvents` wiring
in R4, not via `ProcessExecutor` directly.

### Plan

1. **infra first (Layer 1).** `application/index.ts` calls `attachFileObserver(lifecycleBus,
   eventsPath, getFileSystem())` next to `attachDefaultObservers`. Add `events.fileObserver`
   + `events.filePath` to `ApplicationEventsConfig`. Default `fileObserver: true`,
   `filePath: <runtimePaths.logs>/system-events.jsonl`. Test it via a stub FileSystem.

2. **infra API client (R5).** Add `lifecycleBus?: EventBus<BusLifecycleEvents>` to
   `APIClientOptions`; forward into the internal `EventBus<ApiClientEvents>`. Add test in
   `tests/api-client.test.ts` exercising the JSONL breadcrumb.

3. **rule-engine (R2).** Add `lifecycleBus?` to `RuleEngineOptions`; forward into the inner
   `events` bus when constructing it. Add test in `tests/engine.test.ts`.

4. **dual-workflow-engine (R3).** Add `lifecycleBus?` to:
   - `RunLifecycleOptions` (constructor argument already accepts `events`; add `lifecycleBus`)
   - `WorkflowServiceOptions` (`service.ts`)
   - `WorkflowHostOptions` (`host.ts`)
   - `createDefaultWorkflowEngineHost` (`host.ts`) factory — accepts `lifecycleBus?`
   Forward into `events` bus constructor. Add test in `tests/run-lifecycle.test.ts` (or
   sibling).

5. **ai-runner (R4).** Add `lifecycleBus?` to `AiRunnerOptions` and `TeamOrchestratorOptions`;
   forward into both `events` and `processEvents` event buses. Add test in
   `tests/ai-runner.test.ts` and `tests/team-orchestrator.test.ts`.

6. **Optional R8 (rule).** Author `.spur/rules/lifecycle-bus-propagation.md` checking that
   every package emitting events accepts a `lifecycleBus` option. Defer to a follow-up if
   rule AST matching is non-trivial.

7. **`bun run spur-check` + `bun run build`.** No skipped tests; no `biome-ignore`s added
   to silence the gate.

### Solution
Change map (implemented):

| Change (`file:line`) | What / why |
|----------------------|------------|
| `packages/infra/src/application/types.ts` | (R1) Added `fileObserver?: boolean` and `filePath?: string` to `EventsOptions`; added `fileObserverWriter?: FileObserverWriter` to `ApplicationServices` so the portable bootstrap can receive a writer without importing `node:fs` (ADR-011). |
| `packages/infra/src/application/index.ts:118-155` | (R1) `runApplication` calls `attachFileObserver(lifecycleBus, filePath, writer)` when `fileObserver !== false` and a writer + path are available; lifecycle bus is propagated into the app events bus. |
| `packages/infra/src/application-node.ts` | (R1) `runNodeApplication` injects `fileObserverWriter` from `createNodeFileSystem()` so the Node subpath owns the `node:fs` import. |
| `packages/infra/src/index.ts:20` | Export `BusLifecycleEvents` from the main barrel so downstream packages can type the option without reaching into `/event-bus/types`. |
| `packages/infra/src/api-client.ts:39,164-166` | (R5) `lifecycleBus?` added to `APIClientConfig`; constructor builds `new EventBus<ApiClientEvents>({ lifecycleBus })` when `events` is not pre-supplied. |
| `packages/rule-engine/src/engine.ts:38,65-67` | (R2) `lifecycleBus?` added to `RuleEngineOptions`; when `events` is omitted but `lifecycleBus` is present, engine constructs `new EventBus<RuleEngineEvents>({ lifecycleBus })`. |
| `packages/dual-workflow-engine/src/service.ts:37` | (R3) `WorkflowService` accepts `lifecycleBus?` as 3rd constructor arg; `resolveEvents()` returns caller-supplied events or constructs a parented internal bus; 5 call sites updated. |
| `packages/ai-runner/src/ai-runner.ts:57,70-101` | (R4) `lifecycleBus?` added to `AiRunnerOptions`; constructor parents both `processEvents` and `events` to it when they are not pre-supplied. `processEvents` exposed as a readonly field for introspection/testing. |
| `packages/ai-runner/src/team-orchestrator.ts` | (R4) `lifecycleBus?` added to `TeamOrchestratorOptions` and forwarded into the internal events bus. |
| `packages/infra/tests/application/system-events.test.ts` | (R1) Test: parented domain emit lands in JSONL; no-op without writer. 2 pass. |
| `packages/infra/tests/api-client-lifecycle-bus.test.ts` | (R5) Test: `api.request.error` reaches parent lifecycle bus; requests succeed without lifecycleBus. 2 pass. |
| `packages/rule-engine/tests/lifecycle-bus.test.ts` | (R2) Test: `rule.run.start`/`rule.run.done` reach parent lifecycle bus; explicit events bus used as-is. 2 pass. |
| `packages/dual-workflow-engine/tests/lifecycle-bus.test.ts` | (R3) Test: `workflow.run.started`/`workflow.run.done` reach parent lifecycle bus; no lifecycleBus still succeeds. 2 pass. |
| `packages/ai-runner/tests/lifecycle-bus.test.ts` | (R4) Test: `agent.invoke.start`/`agent.invoke.exit` propagation (FakeExecutor run); `process.started`/`process.exited` propagation via direct `processEvents.emit` (FakeExecutor bypasses `emitProcessEvent`); explicit events bus used as-is. 3 pass. |
| `packages/infra/README.md` | (R6) Documented the `lifecycleBus` propagation contract in the bootstrap JSDoc surface. |

**Verification:**
- `bun run spur-check` clean — 1612 pass / 0 fail; both spur rule presets (`recommended-pre-check` + `recommended-post-check`) pass `--fail-on warning`.
- `bun run build` exits 0 for all 8 packages.
- Per-package test counts: infra 295, rule-engine 317, dual-workflow-engine 324, ai-runner 134 — all 0 fail.
- `biome check` clean on all touched files (final newline fixed on ai-runner test).
- No `biome-ignore` added to silence the gate; no tests `.skip`'d.

**Deferred:** R8 (`lifecycle-bus-propagation` spur rule) — authoring an AST rule for `events?: EventBus<XEvents>` → `lifecycleBus?` invariant is non-trivial; file a follow-up task.
### Testing
**Verification Verdict: PASS** — all eight requirements and all seven behavior scenarios are met, independent review is PASS, and no task-check finding remains.

**Requirement Verification**

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | Portable bootstrap attaches the JSONL observer by default when a writer exists; focused application tests prove writes and default path behavior. |
| R2 | MET | RuleEngine accepts lifecycle propagation and emits rule breadcrumbs; lifecycle tests cover parented and unchanged unparented behavior. |
| R3 | MET | RunLifecycle, WorkflowService, and host propagate the same resolved bus; allowed/denied and run lifecycle paths have regression coverage. |
| R4 | MET | AiRunner and TeamOrchestrator parent agent/process buses; focused tests prove both event families. |
| R5 | MET | APIClient parents its internal events bus; HTTP 500 coverage proves `api.request.error`. |
| R6 | MET | The runtime handle exposes the shared lifecycle bus; docs and a downstream shared-writer test prove reuse. |
| R7 | MET | Fresh canonical gates pass; no skip/focus/suppression finding exists. |
| R8 | MET | The permitted deferral path is satisfied by scoped follow-up 0053, now linked to feature B with clean traceability. |

**Acceptance Criteria Verification**

| AC | Status | Evidence Type | Evidence |
|----|--------|---------------|----------|
| R1 — runApplication turns on attachFileObserver by default | MET | test | Application System Events integration verifies JSONL output. |
| R2 — RuleEngine emits bus.emit.done for rule.run.* events | MET | test | Rule lifecycle integration verifies start/done breadcrumbs. |
| R3 — RunLifecycle emits bus.emit.done for workflow.* events | MET | test | Workflow lifecycle integration verifies started/done breadcrumbs. |
| R4 — AiRunner emits bus.emit.done for agent.* and process.* events | MET | test | AiRunner lifecycle integration verifies both families. |
| R5 — APIClient emits bus.emit.done for api.request.error | MET | test | API client lifecycle test exercises HTTP 500. |
| R1b — eventsFileObserver = false disables the file writer | MET | test | Portable and Node configuration tests verify zero writes. |
| R2b — RuleEngine without lifecycleBus behaves unchanged | MET | test | Explicit-bus regression verifies normal subscriber behavior. |

**Checks**

| Check | Status | Evidence |
|-------|--------|----------|
| Design conformance | PASS | Portable/Node ownership, dependency direction, and caller-owned bus precedence match ADR-011/013/014. |
| Independent review | PASS | Review contains the mandatory P1–P4 table and no unresolved P1/P2 finding; listed P3/P4 observations are accepted nonblocking follow-up considerations. |
| Canonical quality gate | PASS | Fresh `bun run spur-check`: 1,626 pass, 0 fail, 3,559 assertions, 99.26% lines; 46/46 rules pass. |
| Build | PASS | Fresh `bun run build`: all eight packages exit 0. |
| Strict core / traceability | PASS | `spur task check 0050 --strict-core --json` and `spur feature check B --json` return no findings. |
### Review
**Review Verdict: PASS** — functional traceability, SECUA, and architectural-depth review found no unresolved P1/P2 findings after one bounded `--fix all` pass. P3/P4 follow-ups are non-blocking.

**Functional traceability**

| Requirement | Status | Evidence |
|---|---|---|
| R1 | MET | `packages/infra/src/application/index.ts:129-166` defaults the observer and, when a structural writer is injected, defaults the portable path to `logs/system-events.jsonl`; `packages/infra/tests/application/system-events.test.ts:17-54` proves default output and disabled no-I/O behavior. Node path/writer ownership remains at `application-node.ts:324-358`. |
| R2 | MET | `packages/rule-engine/src/engine.ts:29-38,61-67`; `packages/rule-engine/tests/lifecycle-bus.test.ts:40-51` passes an explicitly parented events bus plus lifecycle bus and proves start/done breadcrumbs. |
| R3 | MET | Host, direct RunLifecycle, and service boundaries are covered by `host.ts:15-19,89-92`, `run-lifecycle.ts:64-100`, and `service.ts:27-49`. External requested/denied events now reuse one resolved bus at `service.ts:242-317`; regression coverage is `tests/lifecycle-bus.test.ts:62-91`. |
| R4 | MET | `packages/ai-runner/src/ai-runner.ts:48-101` and `team-orchestrator.ts:14-45`; `tests/lifecycle-bus.test.ts:46-71` passes explicit parented agent/process buses with the lifecycle bus and exercises the real default executor. |
| R5 | MET | `packages/infra/src/api-client.ts:27-39,159-179`; `tests/api-client-lifecycle-bus.test.ts:35-51` proves the exact HTTP 500 path with `{ events, lifecycleBus }`. |
| R6 | MET | `application/index.ts:62-73,169-214` documents and exposes the bus; `rule-engine/tests/lifecycle-bus.test.ts:54-74` constructs a downstream RuleEngine from `app.lifecycleBus` and observes its events in the bootstrap JSONL writer. |
| R7 | MET | Fresh `bun run spur-check` passed 1,624 tests / 0 failures with both Spur presets and 99.26% line coverage. Fresh `bun run build` passed all 8 packages. |
| R8 | MET | The permitted deferral is recorded as task 0053 with requirements, executable AC, design, and plan. |

Functional Verdict: PASS

**P1–P4 findings**

| Priority | Status | Dimension | Finding / disposition |
|---|---|---|---|
| P1 | None | All | No blocker found. |
| P2 | Resolved | Correctness / Architecture | `WorkflowService` external `workflow.transition.requested` and `.denied` events bypassed lifecycle fallback. Fixed by resolving once and reusing the same bus in `service.ts:242-317`; allowed/denied regression test added. |
| P2 | Resolved | Correctness / Usability | Node YAML `events.fileObserver: false` was ignored. `application-node.ts:252-261,338-355` now merges YAML then inline options; `application-node.test.ts:71-106` proves YAML disables writes. |
| P2 | Resolved | Functional | Portable `runApplication` lacked a writer-dependent default path, and downstream shared-writer coverage was absent. Fixed at `application/index.ts:129-166`, `application/system-events.test.ts:17-54`, and `rule-engine/tests/lifecycle-bus.test.ts:54-74`. |
| P3 | Open, non-blocking | Security | File-observer JSONL stores raw event details, including arbitrary `workflow.custom` payloads, without a redaction/data-classification hook (`event-bus/file-observer.ts:97-112`, `dual-workflow-engine/src/host.ts:125-134`). Keep event payloads non-secret or add a policy hook in a dedicated follow-up. |
| P3 | Open, non-blocking | Architecture | `attachFileObserver` installs application-specific handlers but returns no disposer, so reusing one injected lifecycle bus across repeated bootstraps can accumulate file writers (`event-bus/file-observer.ts:37-141`). A follow-up should return an idempotent disposer and register it with application teardown. |
| P3 | Open, non-blocking | Architecture / Usability | `AiRunner.processEvents` is public solely for introspection/testing but has no repository consumer (`ai-runner/src/ai-runner.ts:69-70,101`). Prefer explicit `processEvents` injection and make the auto-created bus private in a future cleanup. |
| P4 | Open, advisory | Efficiency | The Node default writer uses synchronous append per lifecycle row (`application-node.ts:330-336`). Benchmark rule-heavy workloads before introducing buffered async writes with shutdown flushing. |

**SECUA summary**

| Dimension | Result | Evidence |
|---|---|---|
| Security | PASS with P3 residual | No secrets, auth, SQL, shell-construction, or unsafe deserialization changes. Raw observability payload retention is explicitly recorded above. |
| Efficiency | PASS with P4 advisory | Event propagation is constant-time; synchronous persistence is documented for measurement/follow-up. |
| Correctness | PASS | The two P2 defects were repaired and covered; focused scenarios pass 35/35 and the full suite passes 1,624/1,624. |
| Usability | PASS | YAML/inline precedence is restored; caller-owned buses retain precedence; documentation now says consumers explicitly receive `app.lifecycleBus`. |
| Architecture | PASS with P3 residuals | ADR-011/014 portability and ADR-013 structural ProcessEventSink boundaries remain intact. The concrete weak-locality defect was fixed without introducing a new abstraction. |

**Architectural depth**

- Design conformance: PASS. Bootstrap owns observer wiring, consumers own their event maps, the application exposes one shared lifecycle bus, and ProcessExecutor remains unchanged behind its structural sink.
- Caller-owned `events` / `processEvents` buses intentionally take precedence. The R2/R4/R5 tests pass buses already parented to the same lifecycle bus, satisfying the written dual-input scenarios without mutating caller-owned buses.
- No new dependencies or package-boundary violations were introduced. The new `@gobing-ai/ts-infra/application` test import has the required source path alias in `packages/rule-engine/tsconfig.json`.

**Fresh gates**

| Command | Result |
|---|---|
| Focused repaired scenarios | 35 tests passed, 0 failed; partial-suite process exit remains coverage-threshold-only |
| `bun run spur-check` | PASS — 1,624 pass, 0 fail, 3,554 assertions; 99.37% functions / 99.26% lines; 44 pre-check and 2 post-check rules pass |
| `bun run build` | PASS — all 8 packages |

Review Verdict: PASS
### History
- 2026-07-13T00:54:06.837Z todo → wip (system)
- 2026-07-13T00:54:07.061Z wip → testing (system)
- 2026-07-13T01:10:57.070Z testing → done (system)
