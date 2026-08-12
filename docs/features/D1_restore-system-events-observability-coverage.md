---
schema_version: 1
id: "D1"
name: "Restore System Events observability coverage"
status: done
priority: P2
tags: []
created_at: "2026-07-13T05:06:45.677Z"
updated_at: "2026-08-12T14:40:55.498Z"
---

# D1: Restore System Events observability coverage

## Goal
Restore the System Events JSONL pipeline so every in-repository event source reaches the shared lifecycle bus without violating package boundaries, while recording consumer-owned event namespaces explicitly.
## Scope
- In scope: diagnose missing event prefixes; wire lifecycle-bus propagation and the JSONL observer; add durable inbox-message lifecycle events through a structural sink; preserve no-observer behavior and package boundaries.
- Out of scope: consumer-owned `feature.*` / `task.*` event maps; new durable message transitions that have no DAO operation; the ai-runner-owned `MessageStore` port tracked by task 0045.
## Acceptance Criteria
```gherkin
Feature: Restore System Events observability coverage

  Scenario: 0049-R1 — Per-prefix root cause table is complete
    Given the operator's list of working and missing event prefixes
    When the diagnosis is inspected
    Then every prefix has status, root cause, and evidence

  Scenario: 0049-R2 — Single-architectural-gap argument is stated
    Given the lifecycle event pipeline
    When the shared gap is described
    Then bootstrap and bus construction are identified as the two repair seams

  Scenario: 0049-R3 — Two scoped in-repo follow-up tasks exist
    Given the diagnosis is complete
    When retained in-repository work is decomposed
    Then tasks 0050 and 0051 contain requirements, design, and plans

  Scenario: 0049-R4 — feature.* and task.* ownership decision is recorded
    Given those maps belong to a consumer project
    When local scope is reviewed
    Then their ownership and local cancellation are explicit

  Scenario: R1 — runApplication turns on attachFileObserver by default
    Given an injected writer and lifecycle bus
    When the portable application starts with defaults
    Then lifecycle events produce System Events JSONL rows

  Scenario: R2 — RuleEngine emits bus.emit.done for rule.run.* events
    Given a RuleEngine connected to a lifecycle bus
    When rule evaluation runs
    Then rule lifecycle breadcrumbs reach the parent bus

  Scenario: R3 — RunLifecycle emits bus.emit.done for workflow.* events
    Given a workflow runtime connected to a lifecycle bus
    When a workflow runs
    Then workflow lifecycle breadcrumbs reach the parent bus

  Scenario: R4 — AiRunner emits bus.emit.done for agent.* and process.* events
    Given an AiRunner connected to a lifecycle bus
    When an agent process runs
    Then agent and process breadcrumbs reach the parent bus

  Scenario: R5 — APIClient emits bus.emit.done for api.request.error
    Given an API client connected to a lifecycle bus
    When an HTTP request fails
    Then the API error breadcrumb reaches the parent bus

  Scenario: R1b — eventsFileObserver = false disables the file writer
    Given file observation is disabled
    When lifecycle events occur
    Then no System Events JSONL write occurs

  Scenario: R2b — RuleEngine without lifecycleBus behaves unchanged
    Given no lifecycle bus is supplied
    When rule evaluation runs
    Then normal subscribers still work without errors

  Scenario: R1 — InboxMessageDao emits message.enqueued after enqueue persists
    Given a durable inbox DAO with an event sink
    When enqueue commits
    Then a metadata-only enqueued event is emitted after persistence

  Scenario: R2 — InboxMessageDao emits message.injected for drained rows
    Given queued messages and an event sink
    When pending messages are drained
    Then injected events follow the returned-row order

  Scenario: R3 — InboxMessageDao emits terminal delivery events
    Given durable inbox messages and an event sink
    When delivery or failure commits
    Then the matching terminal event is emitted

  Scenario: R4 — Omitting the sink preserves existing DAO behavior
    Given no event sink
    When inbox mutations execute
    Then persistence and return contracts remain unchanged

  Scenario: R5 — A higher-layer EventBus produces lifecycle breadcrumbs directly
    Given a parented EventBus is passed as the structural DAO sink
    When inbox transitions commit
    Then message lifecycle breadcrumbs reach the parent bus

  Scenario: Missing lifecycle propagation is rejected
    Given an EventBus options API has no lifecycle propagation path
    When the architecture rule runs
    Then it reports the API boundary with an actionable finding

  Scenario: Correct lifecycle propagation passes
    Given an EventBus options API correctly parents its internal bus
    When the architecture rule runs
    Then no finding is reported

  # ── 0055: queue.* payload enrichment (payload depth, not delivery) ──

  Scenario: R1 — Consumer started carries config snapshot
    Given a DBQueueConsumer constructed with pollInterval, batchSize, maxConcurrency
    And an EventBus subscribed to queue.consumer.started
    When consumer.start() is called
    Then the bus receives a non-null detail with config fields and startedAt

  Scenario: R1b — Consumer stopped carries drain outcome
    Given a running DBQueueConsumer with an EventBus
    When consumer.stop() is called after start()
    Then queue.consumer.stopped detail includes stoppedAt, drainTimeoutMs, inFlightAtStop, drained

  Scenario: R2 — Enqueue emits correlators beyond jobId/type
    Given a DBJobQueue with an EventBus
    When enqueue succeeds with EnqueueOptions
    Then queue.job.enqueued detail has jobId, type, enqueuedAt and option-derived fields
    And detail does not contain the business job payload

  Scenario: R2b — Batch enqueue matches single-enqueue shape
    Given a DBJobQueue with an EventBus
    When enqueueBatch enqueues multiple jobs
    Then each queue.job.enqueued detail has jobId, type, enqueuedAt

  Scenario: R3 — Completed job includes durationMs
    Given a registered handler that resolves successfully
    When the consumer processes the job to completion
    Then queue.job.completed detail includes jobId, type, durationMs, attempt

  Scenario: R4 — Failed job includes maxRetries and error
    Given a handler that always throws and maxRetries exhausted
    When the job permanently fails
    Then queue.job.failed detail includes jobId, type, error, attempt, maxRetries

  Scenario: R4b — Retrying job includes error reason
    Given a handler that throws with attempts remaining
    When the job is marked for retry
    Then queue.job.retrying detail includes jobId, type, attempt, nextRetryAt, maxRetries, error

  Scenario: R5 — QueueEvents map is fully named-typed
    Given packages/infra/src/events.ts
    When consumers import QueueEvents detail types
    Then every queue.* key has a named exported detail interface

  Scenario: R6 — Regression suite green
    Given the package test suite
    When bun test packages/infra is run
    Then job-queue and events tests pass without skip

  Scenario: R7 — Metadata-only invariant
    Given any queue.* emit path
    When the detail object is inspected
    Then it never embeds the job business payload T
```

## Tasks

<!-- AUTO-GENERATED by spur feature refresh -->
| WBS | Task | Status |
| --- | ---- | ------ |
| 0049 | Diagnosis & fix plan for missing System Events in Observability module | done |
| 0050 | Wire lifecycleBus + attachFileObserver across ts-infra application bootstrap, ai-runner, rule-engine, dual-workflow-engine (fixes agent.* / api.* / bus.* / rule.* / workflow.* / process.* in System Events) | done |
| 0051 | InboxMessageDao emits durable message.* events via a structural sink (message.* in System Events) | done |
| 0052 | Record feature.* / task.* event-map ownership deferral (consumer app owns) | cancelled |
| 0053 | Add lifecycle-bus-propagation architecture rule | done |
| 0055 | Enrich queue.* EventBus payloads (consumer lifecycle + job correlators) for System Events observability | done |
<!-- END AUTO-GENERATED -->

## Notes

## History
- 2026-07-13T05:07:26.741Z backlog → active (system)
- 2026-08-12T13:35:50.661Z active → verifying (system)
- 2026-08-12T13:35:50.784Z verifying → done (system)
- 2026-08-12T14:40:55.498Z moved B → D1 (system)
