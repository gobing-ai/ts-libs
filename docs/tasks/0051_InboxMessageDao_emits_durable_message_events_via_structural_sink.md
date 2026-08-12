---
template: feature-impl
schema_version: 1
name: InboxMessageDao emits durable message.* events via a structural sink (message.* in System Events)
status: done
type: task
feature_id: D1
priority: P2
tags: [observability,message,ts-db,ai-runner,events,structural-sink]
dependencies: ["0049","0050"]
created_at: 2026-07-12T17:45:00.000Z
updated_at: "2026-08-12T14:40:55.498Z"
---

## 0051. InboxMessageDao emits durable message.* events via a structural sink

### Background
Companion to tasks 0049 and 0050. Task 0050 makes `agent.message.sent` observable by
wiring `ai-runner` event buses to a lifecycle bus. The durable half remains invisible:
`packages/db/src/inbox-message-dao.ts` persists inbox transitions but exposes no event
port, and `ts-db` cannot import `EventBus` from `ts-infra` without reversing the package
dependency direction prohibited by ADR-013/ADR-014.

The current implementation has four write paths: `enqueue`, `drainPending`,
`markDelivered`, and `markFailed`. It has no `ack`, `consumeOnce`, or retry operation.
Likewise, `ts-ai-runner` has no `MessageService`; `TeamOrchestrator` directly consumes an
`InboxMessageDao`. This task therefore adds a zero-dependency structural sink to the DAO
and proves that a higher-layer `EventBus<InboxMessageEvents>` can satisfy it directly.
The event vocabulary follows real persisted transitions: `message.enqueued`,
`message.injected`, `message.delivered`, and `message.failed`.

Dependencies: 0049 supplies the diagnosis; 0050 supplies lifecycle-bus/file-observer
wiring for the end-to-end breadcrumb test. `message.acked` and `message.retried` remain
out of scope until corresponding DAO operations exist.
### Requirements
- [x] R1. Define and export `InboxMessageEvents`, `InboxMessageEventSink`, and
  `InboxMessageDaoOptions` from `packages/db/src/inbox-message-dao.ts` and the
  `@gobing-ai/ts-db/inbox` subpath. The event map must contain exactly the currently
  supported persisted transitions: `message.enqueued`, `message.injected`,
  `message.delivered`, and `message.failed`. Payloads must expose stable identifiers and
  transition-specific data without exposing Drizzle types.

- [x] R2. Extend `InboxMessageDao` with a backward-compatible optional second constructor
  argument, `options: InboxMessageDaoOptions = {}`. The DAO must depend only on the
  structural `InboxMessageEventSink`; `ts-db` must not import `@gobing-ai/ts-infra` or
  `EventBus`. With no sink, existing callers and behavior remain unchanged and no no-op
  object is allocated.

- [x] R3. Emit only after each corresponding database mutation succeeds:
  `message.enqueued` after `enqueue`, one `message.injected` per row returned by
  `drainPending`, `message.delivered` after `markDelivered`, and `message.failed` after
  `markFailed`. Emission remains observational: the structural port returns `void`, and
  DAO persistence does not await higher-layer observers.

- [x] R4. Extend `packages/db/tests/inbox-message-dao.test.ts` with a recording structural
  sink that verifies event order and complete payloads for all four transitions, plus a
  regression case proving construction without a sink remains silent and preserves the
  existing DAO contract.

- [x] R5. Add an `ai-runner` integration test that constructs a real
  `EventBus<InboxMessageEvents>` with the lifecycle bus introduced by 0050, passes that bus
  directly as the DAO sink, and verifies `bus.emit.done` breadcrumbs for at least
  `message.enqueued` and `message.delivered`. Do not introduce a `MessageService` or an
  adapter class solely for this wiring.

- [x] R6. Update `packages/db/README.md` with the structural sink API and
  `packages/ai-runner/README.md` with the direct `EventBus` composition example. The docs
  must use the real `InboxMessageDao`/`TeamOrchestrator` surface rather than claiming that
  a `MessageService` implementation exists.

- [x] R7. `bun run spur-check` and `bun run build` pass for all eight packages; no tests are
  skipped and `git status` contains only intentional changes.
### Acceptance Criteria
```gherkin
Feature: Durable InboxMessageDao transitions emit message lifecycle events

  @core
  Scenario: R1 — InboxMessageDao emits message.enqueued after enqueue persists
    Given an InboxMessageDao constructed with a recording InboxMessageEventSink
    When enqueue persists a queued message
    Then the sink receives "message.enqueued" after persistence succeeds
    And the payload identifies the message, sender, recipient, and reply target

  @core
  Scenario: R2 — InboxMessageDao emits message.injected for drained rows
    Given queued messages for one recipient and a recording sink
    When drainPending atomically marks those messages injected
    Then the sink receives one "message.injected" event per returned row in return order
    And each payload contains the message id, recipient id, and injection attempt

  @core
  Scenario: R3 — InboxMessageDao emits terminal delivery events
    Given persisted inbox messages and a recording sink
    When markDelivered succeeds for one message
    Then the sink receives "message.delivered" with its message id and delivery timestamp
    When markFailed succeeds for another message
    Then the sink receives "message.failed" with its message id and error

  @edge
  Scenario: R4 — Omitting the sink preserves existing DAO behavior
    Given an InboxMessageDao constructed without options
    When enqueue, drainPending, markDelivered, and markFailed execute
    Then their persisted state and return values match the pre-change contract
    And no event infrastructure is required

  @core
  Scenario: R5 — A higher-layer EventBus produces lifecycle breadcrumbs directly
    Given an EventBus<InboxMessageEvents> configured with a lifecycle bus
    And that EventBus is passed directly as InboxMessageDao's structural sink
    When enqueue and markDelivered succeed
    Then the lifecycle bus emits bus.emit.done for "message.enqueued"
    And the lifecycle bus emits bus.emit.done for "message.delivered"
```
### Design
Follow the `ProcessExecutor` / `ProcessEventSink` precedent from ADR-013: the package that
owns the behavior (`ts-db`) owns a dependency-free event map and structural sink, while
higher layers provide concrete infrastructure.

```ts
export type InboxMessageEvents = {
    'message.enqueued': (detail: EnqueuedMessageDetail) => void;
    'message.injected': (detail: InjectedMessageDetail) => void;
    'message.delivered': (detail: DeliveredMessageDetail) => void;
    'message.failed': (detail: FailedMessageDetail) => void;
};

export interface InboxMessageEventSink {
    emit<K extends keyof InboxMessageEvents>(
        event: K,
        ...args: Parameters<InboxMessageEvents[K]>
    ): void;
}

export interface InboxMessageDaoOptions {
    events?: InboxMessageEventSink;
}
```

`InboxMessageDao` stores `options.events` and calls it after successful writes. Optional
chaining provides the silent default without allocating a no-op sink. `EventBus` is
structurally compatible with the port, so composition code can pass
`EventBus<InboxMessageEvents>` directly; no `ts-db -> ts-infra` dependency and no adapter
class are needed.

Payloads are explicit public DTOs, not database row types. Capture mutation timestamps
once and reuse the same value for persistence and event detail. For `drainPending`, emit
from the rows returned by the atomic update, preserving their order. Event delivery is
observational and fire-and-forget, matching `ProcessEventSink`; persistence success does
not depend on observer completion.

Out of scope: inventing `ack`/retry DAO methods, adding `message.acked` or
`message.retried`, creating a `MessageService`, changing `TeamOrchestrator` ownership, or
altering the inbox schema.
### Plan
1. Add the four-event map, public detail DTOs, structural sink, and DAO options beside
   `InboxMessageDao` in `packages/db/src/inbox-message-dao.ts`; re-export them from
   `packages/db/src/inbox.ts` and the root barrel.
2. Make the DAO constructor's options argument optional and emit after successful
   `enqueue`, `drainPending`, `markDelivered`, and `markFailed` mutations.
3. Extend `packages/db/tests/inbox-message-dao.test.ts` with recording-sink coverage for
   event order, payloads, and the no-sink regression path.
4. Add an `ai-runner` integration test using `BunSqliteAdapter`, a real
   `EventBus<InboxMessageEvents>`, and a lifecycle bus to prove `bus.emit.done` receives
   durable `message.*` breadcrumbs without a production adapter class.
5. Update both package READMEs with the structural-port contract and actual composition
   surface; remove or correct touched examples that refer to nonexistent `MessageService`
   code.
6. Run `bun run spur-check`, `bun run build`, and inspect `git status` against the intended
   change map.
### Solution
Change map (implemented and review-hardened):

| Change (`file:line`) | What / why |
|----------------------|------------|
| `packages/db/src/inbox-message-dao.ts:14-71` | (R1-R2) Defines metadata-only lifecycle DTOs, the exact four-event map, the dependency-free `void` structural sink, and optional DAO options. Message bodies are excluded from observability payloads. |
| `packages/db/src/inbox-message-dao.ts:89-224` | (R2-R3) Keeps the constructor backward compatible, emits each transition only after persistence, preserves returned-row order/timestamps, and centralizes best-effort delivery in `emitEvent()` so observer throws/rejections cannot invalidate committed mutations. |
| `packages/db/src/inbox.ts:1-10`, `packages/db/src/index.ts:17-26` | (R1) Re-exports the DAO event contract through the `/inbox` subpath and root barrel. |
| `packages/db/tests/inbox-message-dao.test.ts:93-261` | (R4) Recording-sink tests cover exact payloads/order, body exclusion, all four transitions, no-sink compatibility, and synchronous/asynchronous observer failure isolation. |
| `packages/ai-runner/tests/inbox-lifecycle-bus.test.ts:12-70` | (R5) Passes a real parented `EventBus<InboxMessageEvents>` directly to the DAO, verifies enqueue/delivery breadcrumbs, and proves message content is absent from lifecycle payloads. |
| `packages/db/README.md:290-325` | (R6) Documents direct structural composition, metadata-only payloads, best-effort failure isolation, and the pre-redacted error-string contract. |
| `packages/ai-runner/README.md:492-570` | (R6) Documents direct DAO/EventBus/TeamOrchestrator composition without a `MessageService`, including lifecycle-bus and sensitive-error guidance. |

Review fix pass:

- Removed durable message bodies from `message.enqueued` / `message.injected` observability DTOs because lifecycle observers persist event detail to System Events JSONL.
- Added fail-soft structural dispatch so a broken observer cannot make a committed enqueue appear to fail and trigger duplicate retries.
- Added regression coverage for synchronous throws, rejected thenables, and lifecycle payload minimization.
- Corrected standalone README composition and async `getAgentStatus()` usage.

Fresh verification:

- `bun run spur-check` — 1,626 pass / 0 fail / 3,559 assertions, 99.26% line coverage; all 44 pre-check and 2 post-check rules pass with `--fail-on warning`.
- `bun run build` — all eight packages exit 0.
- Focused verification — 15 tests pass / 0 fail / 53 assertions; both affected package typechecks pass and `inbox-message-dao.ts` reaches 100% function/line coverage.
- `git diff --check` clean; no skipped/focused tests, suppressions, new dependencies, or package-boundary violations.

All seven requirements and all five Gherkin scenarios are MET.
### Testing
**Verification Verdict: PASS** — all seven requirements and all five behavior scenarios are met, independent review is PASS, and no task-check finding remains.

**Requirement Verification**

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | Exact four-event metadata contract and structural types are exported from the DAO, `/inbox`, and root barrel. |
| R2 | MET | The optional constructor depends only on the structural sink; direct EventBus compatibility typechecks without a reverse dependency. |
| R3 | MET | Every event follows successful persistence; fail-soft non-awaited dispatch contains synchronous and asynchronous observer failures. |
| R4 | MET | Recording-sink tests verify order, complete metadata, body omission, no-sink behavior, and observer failure isolation. |
| R5 | MET | A real parented EventBus is passed directly to the DAO and produces enqueue/delivery lifecycle breadcrumbs. |
| R6 | MET | DB and AI-runner READMEs document real composition, metadata-only payloads, and pre-redacted failures. |
| R7 | MET | Fresh canonical gates pass; no skip/focus/suppression finding exists. |

**Acceptance Criteria Verification**

| AC | Status | Evidence Type | Evidence |
|----|--------|---------------|----------|
| R1 — InboxMessageDao emits message.enqueued after enqueue persists | MET | test | Exact metadata and persisted timestamp are asserted. |
| R2 — InboxMessageDao emits message.injected for drained rows | MET | test | One event per returned row is asserted in return order. |
| R3 — InboxMessageDao emits terminal delivery events | MET | test | Delivery/failure payloads and persisted timestamps are asserted. |
| R4 — Omitting the sink preserves existing DAO behavior | MET | test | Full enqueue/drain/deliver/fail state contract is exercised without a sink. |
| R5 — A higher-layer EventBus produces lifecycle breadcrumbs directly | MET | test | Direct bus-to-DAO integration verifies enqueue/delivery and content omission. |

**Checks**

| Check | Status | Evidence |
|-------|--------|----------|
| Focused verification | PASS | 15 tests pass, 0 fail, 53 assertions; canonical embedded migrations initialize all three fixtures. |
| Design / SECUA | PASS | ADR-013/014 direction holds; metadata minimization and failure isolation close the material review findings. |
| Independent review | PASS | P1/P2 are resolved; the 0051-local P3 duplicated-DDL finding is resolved; P4 remains explicitly owned by ADR-023/task 0045. |
| Canonical quality gate | PASS | Fresh `bun run spur-check`: 1,626 pass, 0 fail, 3,559 assertions, 99.26% lines; 46/46 rules pass. |
| Build | PASS | Fresh `bun run build`: all eight packages exit 0. |
| Strict core / traceability | PASS | `spur task check 0051 --strict-core --json` and `spur feature check B --json` return no findings. |
### Review
**Review Verdict: PASS** — functional traceability, full SECUA, and architectural-depth review are complete. The bounded fix pass resolved every 0051-local P1–P3 finding; no blocking or major issue remains.

**Severity-ranked findings**

| Priority | Dimension | Finding | Disposition |
|----------|-----------|---------|-------------|
| P1 | All | None. | No blocker found. |
| P2 | Security / Architecture | Durable message bodies crossed into lifecycle detail persisted by System Events observers. | **Resolved:** enqueue/inject DTOs and emits are metadata-only; exact payload and lifecycle tests pin body exclusion. |
| P2 | Correctness | A throwing or rejecting sink could make a committed mutation appear failed. | **Resolved:** all transitions use fail-soft `emitEvent()`; synchronous and rejected-thenable regressions are covered. |
| P3 | Architecture | Inbox table/index DDL was duplicated in three test fixtures. | **Resolved:** DAO and cross-package integration tests now initialize through canonical embedded `applyMigrations`; focused verification passes 15/15. |
| P4 | Architecture | `TeamOrchestrator` still depends on concrete `InboxMessageDao`. | Advisory only and explicitly outside 0051; ADR-023 and task 0045 own the ai-runner `MessageStore` port. |

**Functional traceability**

| Req | Status | Evidence |
|-----|--------|----------|
| R1 | MET | Exact four-event metadata contract and structural types are exported by `packages/db/src/inbox-message-dao.ts`, `/inbox`, and the root barrel. |
| R2 | MET | The optional constructor stores only the dependency-free structural sink; DB and AI-runner typechecks prove direct EventBus compatibility. |
| R3 | MET | Every event follows a successful mutation and fail-soft dispatch cannot invalidate committed state. |
| R4 | MET | Exact order/payload, no-sink, observer-failure, and canonical-migration coverage lives in `packages/db/tests/inbox-message-dao.test.ts`. |
| R5 | MET | `packages/ai-runner/tests/inbox-lifecycle-bus.test.ts` proves direct parented EventBus composition and body omission. |
| R6 | MET | DB and AI-runner READMEs document the real direct-composition surface and pre-redacted failure contract. |
| R7 | MET | Focused tests pass 15/15; final canonical gates are recorded in Testing. |

**SECUA summary**

| Dimension | Result | Evidence |
|-----------|--------|----------|
| Security | PASS | Message content does not cross the persistent observability seam; failure strings require pre-redaction. |
| Efficiency | PASS | One atomic drain mutation and O(n) returned-row emission; metadata-only payloads avoid message-size amplification. |
| Correctness | PASS | Persistence ordering, timestamps, no-sink behavior, and observer failure isolation have executable coverage. |
| Usability | PASS | Public types and examples match the real direct-composition API. |
| Architecture | PASS | ADR-013/014 direction holds; canonical migrations now own test schema setup. |

Functional Verdict: PASS
### History
- 2026-07-13T03:16:21.745Z todo → wip (system)
- 2026-07-13T03:17:45.149Z wip → testing (system)
- 2026-07-13T03:18:15.131Z testing → done (system)
