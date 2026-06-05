---
name: review on ai-runner after the migration
description: review on ai-runner after the migration
status: Done
created_at: 2026-06-05T04:00:06.322Z
updated_at: 2026-06-05T22:43:00.000Z
folder: docs/tasks
type: task
feature-id: ""
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: completed
  testing: completed
---

## 0017. review on ai-runner after the migration

### Background
We already have some blind reviews and fixing on the new ai-runner package in `packages/ai-runner`. But we still need to have a comprehensive review on both the new ai-runner package and the old ai-runner package from the original old project in `~/xprojects/spur-old/packages/kernel/src/ai-runner`. By my original intention, we need to extract this package from it and create a independent package can be reused in other projects.

But now, I already see some migration drifts between the new ai-runner package and the old ai-runner package from the original old project. So I need your help to review and compare these two packages, and come up with a solution to fix the drifts. especially to any:
- Any missing features
- Any uncompleted implementations
- Any inconsistancies

If any, you should list them out as a finding list with severity level for further investigation and fixing.

#### What I already found issues
- Meanwhile, the team mode is the new feature we learned and adopted from another external project. It may be implemented in a different way from the old ai-runner package.
- The original ai-runner delegate to the package in `~/xprojects/spur-old/packages/core/src/process-executor` to execute the AI runner process. But for the new ai-runner package, it uses the new process executor (this is right) and mixes with some raw process.start / process.stop / process.kill (This is not right as it will lose the process management capabilities and observability).
- In the old ai-runner package and process executor package, I remember we use Logger + event bus to implement the observability already (Need to confirm whether we did it completely). For the new ai-runner package and process executor package, we also need to implement the observability in the same way. The prefix for `ai-runner` in event bus should be `agent.`, and the prefix for `process-executor` in event bus should be `process.`. (Can be refined if any better one)

### Requirements
- Find the migration driftings and gaps, and fix them
- Ensure the observability is implemented consistently across the ai-runner and process executor packages
- Standardize the way to add new coding agents -- (TBD: Need to refactor the package or just fix currently implemented ones)


### Q&A

- Scope is a synthesis and closure review for the ai-runner migration drift. The concrete fixes were split into smaller task files because the drift spans detector parity, ProcessExecutor observability, team-process execution, and agent-level eventing.
- The team-mode implementation has no exact old-project counterpart, so parity is evaluated against architectural contracts: all subprocess execution must go through `ProcessExecutor`, process observability must keep the `process.*` taxonomy, and ai-runner orchestration must expose `agent.*` events through the shared EventBus abstraction.

### Design

- Preserve the package boundary from ADR-013: `ts-runtime` exposes structural process event/tracer ports without importing `ts-infra`, while `ts-ai-runner` adapts its injected `EventBus` into those ports.
- Keep `ProcessExecutor` as the single subprocess seam for both single-agent prompt invocation and team-mode child processes.
- Standardize agent observability on `AgentEvents` with `agent.invoke.*`, `agent.started`, `agent.stopped`, and `agent.message.sent`.
- Treat coding-agent registry standardization as a separate low-severity follow-up. The current task fixes behavioral drift first.

### Solution

- Closed the overlapping old/new ai-runner parity drift in task 0016: richer auth/version probing, Codex CLI-first fallback behavior, Gemini credential validation, detector error messages, the `detectChannels` seam, `DoctorRunner.runAll` defensive synthesis, and public re-exports.
- Closed ProcessExecutor observability drift in task 0018: `process.started` / `process.exited` event emission through structural event ports, structural tracer span support, exported process event types, and `AiRunnerOptions.processEvents` wiring into the default executor.
- Closed team-mode process-management drift in task 0019: `TeamAgentProcess` now routes subprocess startup through `ProcessExecutor.runStreaming`, retains `PipeProcess` lifecycle behavior through the executor seam, and logs stop/send/pipe failures instead of swallowing them.
- Closed agent-level observability drift in task 0020: shared `AgentEvents`, `AiRunnerOptions.events`, `agent.invoke.start` / `agent.invoke.exit`, `TeamOrchestrator` EventBus integration, and team lifecycle/message events.

### Plan

- [x] Compare old `spur-old` ai-runner and process-executor contracts against the new `packages/ai-runner` and `packages/runtime` implementation.
- [x] Rank migration drift by severity and map each finding to an implementation task.
- [x] Verify detector and doctor parity fixes from task 0016.
- [x] Verify process observability fixes from task 0018.
- [x] Verify team process execution/logging fixes from task 0019.
- [x] Verify agent EventBus fixes from task 0020.
- [x] Run the canonical repository gates after the fixes.

### Review

- **Verification verdict: PASS.** The migration drift review is reconciled: all Critical/High/Medium findings are fixed by tasks 0016, 0018, 0019, and 0020; the only remaining item is the Low-severity coding-agent registry cleanup deferred as future design work.
- **Critical F1 - FIXED:** `TeamAgentProcess` bypassed `ProcessExecutor` with raw process management, losing the shared execution seam and observability. Fixed by task 0019.
- **Critical F2 - FIXED:** the new `ProcessExecutor` lacked the old `process.started` / `process.exited` event and tracing contract. Fixed by task 0018.
- **High F3 - FIXED:** ai-runner did not emit `agent.*` lifecycle/invocation events. Fixed by task 0020.
- **High F4 - FIXED:** `TeamOrchestrator` used a private listener map instead of the shared `EventBus` abstraction. Fixed by task 0020.
- **Medium F5 - FIXED:** detector behavior had shrunk versus the old package. Fixed by task 0016, with channel parsing intentionally kept as a restored seam rather than completed Phase 2 behavior.
- **Medium F6 - FIXED:** doctor/auth probing behavior had shrunk versus the old package. Fixed by task 0016.
- **Medium F7 - FIXED:** event taxonomy was undefined across runtime and ai-runner. Fixed by tasks 0018 and 0020 with `process.*` and `agent.*`.
- **Low F8 - DEFERRED:** adding new coding agents still touches multiple places. This is a registry/design cleanup, not a remaining migration correctness bug.
- **Low F9 - FIXED:** team process silent catches and missing logger made operational failures opaque. Fixed by task 0019.

### Testing

- 2026-06-05T22:45:00.000Z - `bun run spur-check`
- 2026-06-05T22:46:00.000Z - `bun run build`
- 2026-06-05T22:47:00.000Z - `bun /Users/robin/.agents/skills/rd3-task-runner/scripts/postflight-check.ts 0017 --preset standard`

### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |
| Plan | `docs/plans/2026-06-04-ai-runner-migration-drift-brainstorm.md` | Codex | 2026-06-04 |
| Task | `docs/tasks/0016_Migration_parity_gaps_ai-runner_vs_spur-old_kernel_ai-runner.md` | Codex | 2026-06-04 |
| Task | `docs/tasks/0018_Add_ProcessExecutor_events_tracing_ports.md` | Codex | 2026-06-05 |
| Task | `docs/tasks/0019_Route_TeamAgentProcess_through_ProcessExecutor.md` | Codex | 2026-06-05 |
| Task | `docs/tasks/0020_Add_Agent_EventBus_to_AiRunner_TeamOrchestrator.md` | Codex | 2026-06-05 |

### References
- [Migration drift review & solution brainstorm](../plans/2026-06-04-ai-runner-migration-drift-brainstorm.md) — severity-ranked findings (F1–F9), observability seam design, and decomposition.
- [ADR-013 Addendum — Observability Layering: Injected EventBus vs Structural Port](../00_ADR.md) (2026-06-04)
- Prior parity audit: task 0016 (`Migration parity gaps: ai-runner vs spur-old kernel ai-runner`, **Done**) — resolved the overlapping-file shrinkage (auth/version detection); team-mode observability is the remaining scope, tracked below.
