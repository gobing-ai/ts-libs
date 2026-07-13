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
