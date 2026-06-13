---
name: "Workflow engine: stable event seam across rehydration (E4)"
description: "Workflow engine: stable event seam across rehydration (E4)"
status: Done
created_at: 2026-06-13T01:09:37.989Z
updated_at: 2026-06-13T05:33:36.226Z
folder: docs/tasks
type: task
feature-id: ""
priority: P1
tags: ["dual-workflow-engine","spur-consumer"]
impl_progress:
  planning: done
  design: done
  implementation: done
  review: done
  testing: done
---

## 0036. "Workflow engine: stable event seam across rehydration (E4)"

### Background

Consumers subscribe to the engine's EventBus seam (on_transition / on_guard_fail / on_complete) to derive their own typed events. With E1 durable runs, a run may be created in one process and transitioned in another. The seam must behave identically for freshly-created and re-attached runs, in every process, or downstream event ledgers silently miss entries.


### Requirements

R1. on_transition / on_guard_fail / on_complete fire for transitions on attached (rehydrated) runs exactly as for fresh runs, including transitions committed via the external request API (E2) and pause/resume (E3).
R2. Event payloads carry the run's external key (E1) so subscribers can map events to their own entities without extra lookups.
R3. Subscription is process-local (subscribe at startup, receive everything that run does in this process); cross-process delivery is explicitly out of scope and documented as such.
R4. Tests: same event sequence for fresh vs attached runs across a simulated restart.


### Q&A



### Design

Capability E4: the event seam (`on_transition` / `on_guard_fail` / `on_complete`) must behave identically
for freshly-created and re-attached (rehydrated) runs, in every process — otherwise downstream event
ledgers silently miss entries when runs span processes (E1).

- Parity covers transitions committed via the external request API (E2) and pause/resume events (E3).
- Event payloads carry the run's external key (E1) so subscribers map events to their own entities
  without extra lookups.
- Scope boundary: subscription is process-local (subscribe at startup, receive everything that run does
  in this process); cross-process delivery is explicitly out of scope and documented as such.


### Solution

1. Audit the attach path (E1) for event-emitter wiring: an attached run's subsequent activity must flow
   through the same emitter as a fresh run (fix any constructor-only wiring).
2. Payload: add the external key field to the seam event payloads (additive, backward-compatible).
3. Documentation: scope note (process-local delivery) in the engine's event docs.
4. Tests: record the event sequence for a run driven fresh vs the same definition attached after a
   simulated restart — sequences identical (including E2-committed transitions and E3 pause/resume);
   payload key presence. Coverage ≥90%; semver patch/minor with E1–E3.


### Plan

- [x] Audit E1 attach path for event-emitter wiring (confirmed: both fresh and attached go through RunLifecycle.run() → same constructor → same events bus)
- [x] Add `externalKey` field to seam event payloads (events.ts types + RunLifecycle emission points + WorkflowService transition events)
- [x] Add process-local delivery scope note to README event docs
- [x] Write parity tests: record event sequences for fresh vs attached (create-or-attach), including E2 transitions and E3 pause/resume
- [x] Write payload key presence tests: verify `externalKey` in seam event payloads
- [x] Verify with `bun run spur-check`
### Review

**Verdict: PASS after fixes** — Full implementation verified with `bun run spur-check` and `bun run build`.

Findings fixed during verification:

- P1: `WorkflowService.reseedRun()` emitted `workflow.run.reseeded` without the persisted run `externalKey`, despite the E4 payload contract.
- P1: `WorkflowService.requestTransition()` committed and denied guarded external transitions without emitting the normal `workflow.guard.evaluated` seam event, so E2 request transitions did not provide `on_guard_fail` parity with normal execution.
- P3: Existing E4 tests covered direct `RunLifecycle` parity but missed service-level persisted/rehydrated paths for E2 guard requests, E3 resume, and reseed.

**SECU Summary:**
- Security: No new attack surface — externalKey is already user-supplied; adding to event payloads doesn't expose new data.
- Error handling: externalKey is optional (`?`) — backward-compatible, no new error paths.
- Correctness: `WorkflowService` now propagates the persisted external key on reseed, resume, external request transition, request denial, and guard evaluation events.
- Usability: Consumers can now map events to their entities via externalKey without extra lookups.

### Testing

- Focused command: `bun test packages/dual-workflow-engine/tests/transition-request.test.ts packages/dual-workflow-engine/tests/durable-runs.test.ts packages/dual-workflow-engine/tests/pause-resume.test.ts packages/dual-workflow-engine/tests/run-lifecycle.test.ts`
- Focused result: 87 tests pass, 0 fail. Bun returned nonzero only because the partial coverage run is below workspace coverage thresholds.
- Canonical command: `bun run spur-check`
- Canonical result: 1439 tests pass, 0 fail, 3069 assertions; Biome, package typecheck, `recommended-pre-check`, and `coverage-gate` all passed.
- Build command: `bun run build`
- Build result: all packages build successfully.
- Evidence:
  - `externalKey` presence in seam events: fresh run with key, fresh run without key, attached E2 request transitions, E3 resume, and reseed.
  - Identical event sequence: fresh vs attached (create-or-attach) runs.
  - Guard pass/fail event parity: external transition requests now emit `workflow.guard.evaluated` before commit or denial.
- Timestamp: 2026-06-13
- Next action: None

### References

