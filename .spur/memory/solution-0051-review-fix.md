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
