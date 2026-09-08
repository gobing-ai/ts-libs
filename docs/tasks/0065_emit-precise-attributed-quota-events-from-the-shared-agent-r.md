---
schema_version: 1
name: Emit precise attributed quota events from the shared agent runner
status: done
template: standard
created_at: 2026-09-07T23:42:37.205Z
updated_at: "2026-09-08T00:01:15.343Z"

done_forced: "true"
done_reason: "Verified by run: packages/ai-runner 217/217 tests pass; bun run lint, spur-check (incl. coverage-gate + tsdoc rules), and bun run build all exit 0. Evidence recorded in Testing section."
---

## 0065. Emit precise attributed quota events from the shared agent runner

### Background

Upstream half of Spur task 0798 (feature B5 executor availability, ADR-111). Spur needs a precise upstream quota observation contract — separate from resource-exhaustion — shared by buffered and streaming execution, so persistent executor disabling keys off confirmed quota exhaustion only.

### Requirements

- [x] R1. Reusable precise quota classification plus a single `agent.quota.exhausted` producer shared by buffered invocation failures, bounded streaming error records, and an explicitly opted-in health-observation path. One event per observation with stable observationId (stable across redelivery), observedAt normalized to UTC millisecond precision, reason and evidenceSource, optional exact project/executor/agent/model attribution (from a new optional `AgentRunOptions.quotaContext`), and run correlation. Define `agent.quota.recovered` and its payload type with no automatic producer.
- [x] R2. Never classify generic HTTP 429, temporary throttling, overload, authentication failures, context/output limits, timeouts, unknown errors, or quoted prompt content as quota exhaustion; preserve original runner results and output callbacks; classifier accepts only structured provider codes or verified error records — no free-text transcript scanning.

### Acceptance Criteria

```gherkin
Feature: Emit precise attributed quota events from the shared agent runner

  @core
  Scenario: R1 — Confirmed quota failures emit one precise attributed event
    Given a supported instrumented invocation or opted-in health observation confirms exhausted usage allowance or credits
    When the shared runner classifies the observation
    Then one agent.quota.exhausted event carries stable observation identity and exact available attribution across buffered and streaming paths

  @core
  Scenario: R2 — Transient and unrelated failures never persistently disable executors
    Given a failure is generic HTTP 429, throttling, overload, authentication, context length, output budget, timeout, or unrelated quoted text
    When the failure is classified
    Then no quota-exhaustion event is produced and the original failure result remains intact
```

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

New shared module `packages/ai-runner/src/quota.ts` owns classification and observation types; `events.ts` extends `AgentEvents` with the two quota events; `ai-runner.ts` classifies buffered non-zero exits and carries optional `quotaContext`; `team-agent-process.ts` retains a bounded trailing stderr window and classifies on errored exit; `model-health-probe.ts` gains an explicitly opted-in observation helper (ordinary doctor stays read-only). observationId is a deterministic digest over evidence identity so redelivery is stable; emission is deduped per producer instance. No recovery producer, timer, or polling. DoctorRunner is untouched.

### Plan

<!-- Ordered implementation checklist. Fill before moving to todo/wip. -->

### Solution

Change map (source commit on branch `sp/quota-observation-0798`):

| Change (file:line) | Rationale |
| --- | --- |
| packages/ai-runner/src/quota.ts:1-190 (new) | Shared classifier: exact-match allowlist over JSON error envelopes (`error.type`/`error.code`), bounded trailing evidence (8 KiB), deterministic `observationId` (sha256 over source+reason+attribution — timestamp-free so redelivery keeps identity), UTC-ms `observedAt`, `QuotaObservationProducer` with one-emit-per-observationId dedup and explicit-only recovery delivery |
| src/events.ts:39-41 | `agent.quota.exhausted` + `agent.quota.recovered` typed event map entries |
| src/ai-runner.ts:52 | Optional `AgentRunOptions.quotaContext` (projectId/executor/agent/model) — additive; absent fields stay absent |
| src/ai-runner.ts:170,268-281 | Buffered path: non-zero exit stderr classified once; confirmed → one attributed observation via the producer; original `AgentRunResult` untouched |
| src/team-agent-process.ts:47,58,83,155,167-180 | Streaming path: bounded trailing stderr window (`MAX_QUOTA_EVIDENCE_BYTES`), classify on errored exit, attribution from quotaContext with spec-id/executor fallback; subscriber callbacks unchanged |
| src/model-health-probe.ts:252-286 | `observeQuotaHealthResult` — the ONLY health-path producer, explicitly opted in; `rate_limited`/`unavailable`/`unknown`/`available` return null; ordinary DoctorRunner untouched (read-only preserved) |
| src/index.ts | `export * from './quota'` |

No recovery producer/timer/polling; no stdout or transcript scanning; no provider polling; attribution never inferred.

### Testing

- `bun test` (packages/ai-runner): 217 pass / 0 fail — new tests/quota.test.ts (22 tests: positive insufficient_quota/insufficient_credit_balance/usage_limit_reached; negative 429 rate-limit, overload, auth, context-length, timeout, free text, quoted prompt content in error.message, non-JSON; bounded window; identity stability; dedup; explicit recovery) + buffered tests in tests/lifecycle-bus.test.ts (5) + streaming tests in tests/team-agent-process.test.ts (4, real subprocesses) + opt-in health tests in tests/model-health-probe.test.ts (1)
- `bun run lint`: exit 0 (biome + per-package tsc)
- `bun run spur-check`: exit 0 — pre-check rules, tests with per-file 0.9 coverage (coverage-gate PASS), every-export-has-tsdoc PASS
- `bun run build`: exit 0 — all packages including @gobing-ai/ts-ai-runner dist/

Verdict: PASS (upstream producer implemented; integration requires the next released @gobing-ai/ts-ai-runner version — release flow is operator-gated, not run here)

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to features, docs, ADRs, related tasks, or external references. -->

### History

- 2026-09-07T23:43:36.791Z backlog → todo (system)
- 2026-09-08T00:01:15.332Z todo → done (system)

