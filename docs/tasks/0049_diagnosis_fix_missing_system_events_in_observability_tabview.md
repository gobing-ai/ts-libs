---
schema_version: 1
name: "Diagnosis & fix plan for missing System Events in Observability module"
status: done
template: feature-impl
created_at: 2026-07-12T17:00:00.000Z
updated_at: "2026-07-13T05:11:49.310Z"
feature_id: B
priority: P1
tags: ["observability", "system-events", "event-bus", "infra", "ai-runner", "rule-engine", "dual-workflow-engine", "diagnostic"]
---

## 0049. Diagnosis & fix plan for missing System Events in Observability module

### Background
The Operability module's "System Events" tabview only displays `queue.*` and `scheduler.*`
events, even though the codebase defines event maps for many more prefixes (`agent.*`, `api.*`,
`bus.*`, `rule.*`, `workflow.*`, `process.*`). Three prefix groups named in the operator's
review (`feature.*`, `task.*`, `message.*`) are also absent — `feature.*` and `task.*` are not
defined as event maps anywhere in the repository, while `message.*` is partially defined inside
`AgentEvents` but its durable counterpart does not emit.

This task **diagnoses** the root cause, lays out the gap per prefix with file:line evidence,
proposes the canonical fix, and scopes two in-repo follow-up tasks (0050 and 0051). The
`feature.*` / `task.*` ownership work belongs to another project, so 0052 is cancelled in this
repository and its task file may be removed. This is itself a non-code investigation — code
changes land in the two retained follow-ups.

**Pre-fix codebase facts (captured 2026-07-12, before 0050/0051)**

```
Dependency graph (ADR-002 / ADR-013 addendum):
  ts-utils → ts-runtime → ts-db → ts-infra → ts-ai-runner

Buses that emit lifecycles (per concern):
  queue.*        ts-infra       DBJobQueue / QueueConsumer           wired via constructor DI from runApplication
  scheduler.*    ts-infra       wrapScheduledHandler                wired via runApplication
  agent.*        ts-ai-runner   AiRunner / TeamOrchestrator         NOT wired to the JSONL stream
  api.*          ts-infra       APIClient.events (optional)         NOT wired to the JSONL stream
  bus.*          ts-infra       EventBus internal lifecycle events   NOT visible to System Events tabview
  rule.*         ts-rule-engine RuleEngine.events (optional)        NOT wired to the JSONL stream
  workflow.*     ts-dual-workflow-engine RunLifecycle / service / host NOT wired to the JSONL stream
  process.*      ts-runtime     ProcessExecutor (structural sink)   only forwarded via ai-runner.processEvents bus
  feature.*      —              no typed event map anywhere         does not exist
  task.*         —              no typed event map anywhere         does not exist (spur CLI is file-based)
  message.*      ts-ai-runner   agent.message.sent exists; durable InboxMessageDao never emits
```

**Single pipeline to the System Events tabview** (verified):

```text
bus.emit(K, …) inside a primary bus
  └─ if that primary bus was constructed with { lifecycleBus }
       └─ emits "bus.emit.done" on the lifecycleBus with detail.event = String(K)
            └─ attachFileObserver writes JSONL row: { ts, lifecycle: "bus.emit.done",
               event: K, syncCount, asyncCount, emitDurationMs, errors, payload }
                 └─ file I/O via injected FileSystem (no node:fs — ADR-011)
                      └─ JSONL row consumed by the Observability module
```

**Why only queue.* / scheduler.* worked (pre-fix baseline)**

1. `ts-infra`'s `runApplication` (`packages/infra/src/application/index.ts:139-149`) creates a
   `lifecycleBus` by default and constructs every primary bus from it.
2. `DBJobQueue` (`packages/infra/src/job-queue/db-job-queue.ts:30,189,206`) and
   `wrapScheduledHandler` (`packages/infra/src/scheduler/wrap-handler.ts:46`) emit through that
   bus — their events reach `bus.emit.done` → JSONL → tabview.
3. **Every other package constructs a bare `new EventBus<XEvents>()` with no
   `lifecycleBus`.** A grep across `packages/rule-engine/`, `packages/dual-workflow-engine/`,
   `packages/ai-runner/` returns **zero** references to `lifecycleBus`, `createLifecycleBus`,
   or `attachFileObserver`.
4. `attachFileObserver` is exported from `ts-infra` (`event-bus/index.ts:8`) and unit-tested
   (`tests/event-bus/file-observer.test.ts`), **but nobody calls it.** `runApplication` only
   calls `attachDefaultObservers` (`application/index.ts:142-144`), which writes human-readable
   logs, not JSONL.
5. `bus.*` "missing" is a sub-case of #4 — `bus.emit.done` *does* fire everywhere a `lifecycleBus`
   is wired, but the file observer is opt-in and no consumer turns it on. The logs observer
   picks it up as text and swallows it.

**Root cause summary (operator prefix list)**

| Prefix | Status | Root cause | Evidence |
|--------|--------|------------|----------|
| `queue.*` | working | infra-internal; bus constructed by `runApplication` with `lifecycleBus` | `infra/src/job-queue/db-job-queue.ts:30,189,206` |
| `scheduler.*` | working | infra-internal `wrapScheduledHandler`; same path | `infra/src/scheduler/wrap-handler.ts:46` |
| `agent.*` | missing | ai-runner primary bus has no `lifecycleBus`; no `attachFileObserver` consumer | `ai-runner/src/team-orchestrator.ts:35`; `ai-runner/src/ai-runner.ts:47-52` |
| `api.*` | missing | `APIClient.events` optional, never wired with a lifecycleBus | `infra/src/api-client.ts:27-31,166-168` |
| `bus.*` | missing visible | `bus.emit.done` fires only inside a wired bus; `attachFileObserver` never called in production | `infra/src/application/index.ts:142-144`; zero `attachFileObserver` callsites |
| `rule.*` | missing | rule-engine accepts optional `EventBus<RuleEngineEvents>` but never receives a lifecycleBus | `rule-engine/src/engine.ts`; zero `lifecycleBus` refs in package |
| `workflow.*` | missing | dual-workflow-engine accepts optional `EventBus<WorkflowEngineEvents>` but never receives a lifecycleBus | `dual-workflow-engine/src/run-lifecycle.ts:150,231,249,264,278,294,306`; `service.ts:117,143,265,288`; `host.ts:113,130` |
| `process.*` | missing | `ProcessExecutor` uses structural sink (`ProcessEventSink`) per ADR-013; sink reaches `ai-runner.processEvents` with no `lifecycleBus` | `runtime/src/process-executor.ts:64`; `ai-runner/src/ai-runner.ts:49,62-75` |
| `feature.*` | does not exist | net-new — no `FeatureEvents` map; spur feature CLI is file-based | grep: zero `feature.` event keys |
| `task.*` | does not exist | net-new — same shape; spur task CLI is file-based | grep: zero `task.` event keys |
| `message.*` | partial | `agent.message.sent` exists in `AgentEvents`; `InboxMessageDao` emits nothing | `ai-runner/src/events.ts:21`; zero InboxMessageDao emission |

**Why this is one architectural gap, not nine bugs**

Six bus-backed missing prefixes (`agent.*`, `api.*`, `bus.*`, `rule.*`, `workflow.*`, and
`process.*`) share the same shape: their primary buses were not parented to a `lifecycleBus`,
and the pre-fix `runApplication` bootstrap did not attach the JSONL file observer. Durable
`message.*` required the separate structural-sink follow-up 0051; `feature.*` / `task.*` remain
consumer-owned.

A single architectural fix turns six of the nine entries green:

1. Portable `ts-infra.runApplication` attaches `attachFileObserver` when events are enabled,
   `fileObserver` is not `false` (default-on), and an explicit writer + path are available. The
   Node adapter owns filesystem creation and the default `logs/system-events.jsonl` path; callers
   may override either input.
2. Every primary-bus constructor that takes an `events?` option gains `lifecycleBus?` /
   inherits the constructor's `lifecycleBus` (so a single lifecycleBus hydrates every bus
   the package owns). When `runApplication` builds the app bus and propagates that bus to
   rule/workflow/ai-runner/api-client, every `emit()` automatically produces JSONL rows.
3. Optional: add a `spur` rule enforcing the convention (ADR-006 — invariants are rules).

**Out of scope for this task:** production code changes and `feature.*` / `task.*` typed maps.
The consumer project owns those maps; no in-repo follow-up task or artifact is required.
### Q&A
**Q1. Why does the bus.emit() → bus.emit.done path work at all? It looks like noise.**
It's not noise — it's the operator's chosen observability seam (ADR-009 → ADR-013 addendum).
`bus.emit.done` is the "this happened" breadcrumb that all three observer layers (log, span,
JSONL) subscribe to. The bug is not in the bus; it's that the JSONL consumer
(`attachFileObserver`) is not wired in the application bootstrap, and the lower packages never
ask for a `lifecycleBus`.

**Q2. Could we just drop `attachFileObserver` and write events directly from each package?**
No — that regresses the ADR-009 / ADR-013 model. The bus layer is the single source of truth;
observers must subscribe, not be hard-coded into emitters. The fix is to wire the existing
observer.

**Q3. Does `ProcessExecutor` need direct access to `attachFileObserver`?**
No — `ProcessExecutor` stays structural (ADR-013 addendum: ports are interface-only at the
runtime layer; can't import `EventBus` due to the dependency cycle). The `ProcessEventSink`
port already exists (`process-executor.ts:64`); the fix is that the consumer of the sink
(`AiRunnerOptions.processEvents`) accepts a `lifecycleBus` and forwards through it.

**Q4. What about `feature.*` and `task.*`? They don't exist as events at all.**
Confirmed by grep: zero event keys match `feature.` / `task.` in any `events.ts`. These
prefixes belong to the consumer-side product management layer (spur-style), not to
`ts-libs`. **Decision:** retain the ownership finding in this diagnosis, but implement and
track it in the consumer project. Task 0052 is cancelled in this repository; no local ADR or task
file is required for 0049 to close.

**Q5. Is `message.*` a follow-up or part of this fix?**
The `agent.message.sent` half already exists and is fixed automatically once we wire
`ai-runner`'s bus with a `lifecycleBus` (0050). The durable half (`message.enqueued`, `message.injected`, `message.delivered`, and
`message.failed` from `InboxMessageDao`) is its own follow-up (0051 — structural-port pattern,
same as `ProcessEventSink`). The DAO has no ack or retry operation.
### Requirements
- [x] R1. Per-prefix root-cause table covers every operator-listed prefix plus working `queue.*` / `scheduler.*`, each with status, root cause, and file:line evidence (under Background).

- [x] R2. Single-architectural-gap argument states why six of nine missing prefixes share one fix shape, naming the two change sites: application bootstrap + bus construction.

- [x] R3. Two in-repo follow-up tasks exist and are scoped: **0050** (lifecycleBus + `attachFileObserver` wiring) and **0051** (InboxMessageDao durable `message.*` via structural sink). Each has Requirements, Design, and Plan.

- [x] R4. Ownership of `feature.*` / `task.*` is recorded in Q&A and Background as external to this repository; 0052 is cancelled locally and no local file is required.

- [x] R5. Out of scope for 0049: implementing the architectural fix (0050), durable message sinks (0051), or inventing `FeatureEvents` / `TaskEvents` in this repository.
### Acceptance Criteria
```gherkin
Feature: Diagnosis of missing System Events in Observability module

  @core
  Scenario: 0049-R1 — Per-prefix root cause table is complete
    Given the operator's review list of missing prefixes
      (agent, api, bus, feature, message, process, rule, task, workflow)
    When the diagnosis Background is read end-to-end
    Then each prefix has a row in the root-cause table with status, root cause, and file:line evidence
    And queue.* and scheduler.* are listed as working with the same evidence format

  @core
  Scenario: 0049-R2 — Single-architectural-gap argument is stated
    Given the dependency graph and the bus.emit → bus.emit.done → JSONL pipeline
    When the Background subsection "Why this is one architectural gap, not nine bugs" is read
    Then it explains why 6 of 9 missing prefixes share the same root cause
    And it identifies the two places that need to change: application bootstrap + bus construction

  @core
  Scenario: 0049-R3 — Two scoped in-repo follow-up tasks exist
    Given the retained in-repo decomposition (0050 and 0051)
    When this task is marked Done
    Then docs/tasks/0050_*.md exists (lifecycleBus + attachFileObserver wiring)
    And docs/tasks/0051_*.md exists (InboxMessageDao events)
    And both follow-ups have Requirements, Design, Plan sections

  @edge
  Scenario: 0049-R4 — feature.* and task.* ownership decision is recorded
    Given feature.* / task.* have no repo-level event maps today
    When the diagnosis is read
    Then the Q&A and Background record the recommendation that these belong to the consumer app
    And the diagnosis records that 0052 is cancelled locally because the consumer project owns the work
```


### Design
**Diagnosis deliverable shape** — this task's design *is* the documented root-cause analysis
plus the proposed fix for follow-ups. No package source is modified under 0049.

**The architectural fix (implementation lands in 0050):**

```ts
// packages/infra/src/application/index.ts — portable core
const eventsFileObserver = options.config?.events?.fileObserver ?? true;
const eventsFilePath = options.config?.events?.filePath;
const fileObserverWriter = options.services?.fileObserverWriter;

if (lifecycleBus && eventsFileObserver && eventsFilePath !== undefined && fileObserverWriter !== undefined) {
    attachFileObserver(lifecycleBus, eventsFilePath, fileObserverWriter);
}

// packages/infra/src/application-node.ts owns filesystem creation and
// supplies the default logs/system-events.jsonl path plus writer.
```

```ts
// Every package constructor — pattern (0050, applied per receiving bus):
export interface RuleEngineOptions {
    events?: EventBus<RuleEngineEvents>;
    lifecycleBus?: EventBus<BusLifecycleEvents>; // NEW: propagate to events bus
}

// Inside constructor:
const events = options.events ?? new EventBus<RuleEngineEvents>({ lifecycleBus: options.lifecycleBus });
```

The shared `lifecycleBus` is created once in `runApplication` and **propagated through the call
graph** the same way the `events` bus already is. Once it is propagated, *every* `emit()` on
those buses produces a JSONL row automatically.

**Related follow-up designs**

| Task | Design intent |
|------|----------------|
| 0050 | Wire file observer + propagate `lifecycleBus` → green for agent/api/bus/rule/workflow/process |
| 0051 | Structural `InboxMessageEventSink` on DAO (ADR-013; no EventBus import in ts-db) |
| External | Consumer project owns `feature.*` / `task.*`; local task 0052 is cancelled |
### Plan
This diagnosis task has **no production code plan**. Work items:

1. Land diagnosis content in Background / Requirements / Design / Q&A (this refine).
2. Confirm the two retained in-repo follow-ups exist and are scoped:
   - **0050** — `feat(infra): lifecycleBus + attachFileObserver wiring`. Touches
     `infra/src/application/index.ts`, `infra/src/api-client.ts`, `rule-engine/src/engine.ts`,
     `dual-workflow-engine/src/run-lifecycle.ts`, `dual-workflow-engine/src/host.ts`,
     `dual-workflow-engine/src/service.ts`, `ai-runner/src/ai-runner.ts`,
     `ai-runner/src/team-orchestrator.ts`. Plus a unit test in each package proving
     `emit('rule.run.start', …)` produces a JSONL row (and likewise for the other prefixes).
     Order: infra first, then each consuming package.
   - **0051** — `feat(db): InboxMessageDao emits message.* via structural sink`. Mirrors the
     `ProcessEventSink` precedent; adds an `InboxMessageEvents` map and accepts a structurally
     compatible higher-layer `EventBus` directly. No `MessageService` is introduced.
   - **0052 cancelled locally** — `feature.*` / `task.*` belongs to the consumer project;
     its local task file may be removed and is not a completion dependency for 0049.
3. Verify diagnosis claims with the rg commands listed under Testing.
4. Mark 0049 Done when R1–R4 are satisfied and the 0050/0051 task files are present.


### Solution
Diagnosis-only task — no package source changes under 0049. Solution evidence is the
documented analysis and the two retained follow-up task files.

**Citations anchoring the diagnosis**

- Lifecycle bootstrap: `packages/infra/src/application/index.ts:139-149` (`lifecycleBus` +
  `attachDefaultObservers` only).
- Working emitters: `packages/infra/src/job-queue/db-job-queue.ts:30,189,206`;
  `packages/infra/src/scheduler/wrap-handler.ts:46`.
- File observer unused: export `packages/infra/src/event-bus/index.ts:8`; test
  `packages/infra/tests/event-bus/file-observer.test.ts`; production callsites = none.
- `bus.emit.done` publish: `packages/infra/src/event-bus/event-bus.ts:272`; observer write
  path `packages/infra/src/event-bus/file-observer.ts:97`.
- Unwired consumer buses: `packages/ai-runner/src/ai-runner.ts:47-52`;
  `packages/ai-runner/src/team-orchestrator.ts:35`;
  `packages/infra/src/api-client.ts:27-31,166-168`;
  `packages/dual-workflow-engine/src/run-lifecycle.ts:150+`;
  `packages/runtime/src/process-executor.ts:64` (structural sink).

**Follow-ups produced**

- `docs/tasks/0050_*.md` — wire lifecycleBus + attachFileObserver
- `docs/tasks/0051_*.md` — InboxMessageDao structural message events
- Task 0052 — cancelled locally; feature.*/task.* tracking moved to the consumer project


### Testing
**Verification Verdict: PASS** — all diagnosis requirements and acceptance criteria are met, independent review is PASS, and no task-check finding remains.

**Requirement Verification**

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | Background contains the complete per-prefix status/root-cause/evidence table. |
| R2 | MET | The shared six-prefix gap and its bootstrap/bus-construction repair seams are explicit. |
| R3 | MET | Retained follow-ups 0050 and 0051 exist, are fully specified, reviewed, verified, and done. |
| R4 | MET | Consumer ownership and local cancellation of `feature.*` / `task.*` work are explicit throughout 0049. |
| R5 | MET | 0049 remains diagnosis-only; production implementation is isolated to retained follow-ups. |

**Acceptance Criteria Verification**

| AC | Status | Evidence Type | Evidence |
|----|--------|---------------|----------|
| 0049-R1 — Per-prefix root cause table is complete | MET | inspection | All requested prefixes plus working queue/scheduler rows are present. |
| 0049-R2 — Single-architectural-gap argument is stated | MET | inspection | Both repair seams and the six-prefix common cause are named. |
| 0049-R3 — Two scoped in-repo follow-up tasks exist | MET | command | `spur task show 0050/0051` returns both tasks as done. |
| 0049-R4 — feature.* and task.* ownership decision is recorded | MET | inspection | External ownership and local 0052 cancellation are unambiguous. |

**Checks**

| Check | Status | Evidence |
|-------|--------|----------|
| Independent review | PASS | Review contains the mandatory P1–P4 table and no unresolved P1/P2 finding. |
| Canonical quality gate | PASS | Fresh `bun run spur-check`: 1,626 pass, 0 fail, 3,559 assertions, 99.26% lines; 46/46 rules pass. |
| Build | PASS | Fresh `bun run build`: all eight packages exit 0. |
| Strict core / traceability | PASS | `spur task check 0049 --strict-core --json` and `spur feature check B --json` return no findings. |

Coverage: N/A for the diagnosis-only scope; repository coverage remains 99.26% lines.
### Review
**Review verdict: PASS**

Scope: task 0049's diagnosis/documentation artifact. Production implementation changes belong to
retained follow-ups 0050 and 0051 and were used only as conformance evidence.

**Functional traceability**

| Req | Status | Evidence |
|-----|--------|----------|
| R1 | MET | Prefix table contains all 11 required rows with status, root cause, and file:line evidence (`docs/tasks/0049_*.md:82-94`). |
| R2 | MET | The pre-fix diagnosis identifies the six bus-backed prefixes and both the bootstrap and bus-construction seams (`docs/tasks/0049_*.md:96-112`). |
| R3 | MET | 0050 and 0051 are `done`; each contains Requirements, Design, and Plan. |
| R4 | MET | Background, Q&A, Requirements, AC, Design, and Plan record consumer ownership and local cancellation without requiring the 0052 file. |
| R5 | MET | Production implementation and in-repo FeatureEvents/TaskEvents remain explicitly outside 0049's scope. |

Functional Verdict: PASS

**Priority findings**

| Priority | Dim | file:line | Description | Remediation |
|----------|-----|-----------|-------------|-------------|
| P1 | — | — | No blockers | — |
| P2 | Correctness | `docs/tasks/0049_*.md:98-108,146-148` | Shared-gap scope, file-observer defaults/seam, and durable message vocabulary were internally inconsistent. | Fixed by `--fix all`: narrowed to six bus-backed prefixes; documented default-on writer/path injection and Node ownership; replaced nonexistent `message.acked` with enqueued/injected/delivered/failed. |
| P3 | — | — | No residual minor findings | Pre-fix baseline is now explicit; the Design example matches the delivered core/adapter seam; stale pending-review text and malformed command rendering were removed. |
| P4 | — | — | No advisories | — |

**SECUA (focus=all)**

- Security: no production security surface in 0049 scope; no finding.
- Efficiency: no runtime path in 0049 scope; no finding.
- Correctness: post-fix diagnosis, requirements, and evidence are internally consistent.
- Usability: pre-fix versus post-fix timing is explicit; evidence remains readable and repeatable after 0052 removal.
- Architecture: package ownership follows ADR-013/ADR-014; portable core receives an injected writer/path while the Node adapter owns filesystem creation and the default path.

**Architectural depth**

No shallow-module, tight-coupling, wrong-seam, weak-locality, or poor-test-surface candidate remains
within 0049's documentation scope after the Design correction.

**Fix pass (`--fix all`)**

- Corrected the six-prefix shared-gap claim and labeled the dated facts as a pre-fix baseline.
- Corrected file-observer defaults and portable-core/Node-adapter ownership.
- Corrected durable message event vocabulary to match InboxMessageDao.
- Made R4/AC-R4 verification self-contained so deleting task 0052 does not invalidate evidence.
- Replaced the stale pending review and removed ambiguous nested-backtick command rendering.

Disposition: PASS — no P1/P2 findings remain; P3/P4 are empty after the bounded fix pass.
### History
- 2026-07-13T00:21:32.064Z todo → wip (system)
- 2026-07-13T00:21:38.130Z wip → testing (system)
- 2026-07-13T03:17:09.397Z testing → done (system)
