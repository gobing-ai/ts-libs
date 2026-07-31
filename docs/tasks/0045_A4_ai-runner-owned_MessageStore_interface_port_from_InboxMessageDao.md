---
template: standard
schema_version: 1
name: "A4: ai-runner-owned MessageStore interface port from InboxMessageDao"
status: done
type: task
priority: P3
created_at: 2026-07-13T16:53:27.080Z
updated_at: 2026-07-13T20:32:41.981Z
---

## 0045. A4: ai-runner-owned MessageStore interface port from InboxMessageDao

### Background

ADR-023 follow-up A4 requires `ts-ai-runner` to own the message persistence port consumed by `TeamOrchestrator`. Today `packages/ai-runner/src/team-orchestrator.ts` accepts the concrete `InboxMessageDao`, while `packages/ai-runner/src/messages.ts` formats the concrete `InboxMessage` type. Those imports couple ai-runner's production source and package manifest to `ts-db`, and force in-memory test doubles through unsafe casts even though the orchestrator uses only four store operations.

Introduce a narrow ai-runner-owned `MessageStore` contract and a minimal message view containing only the fields consumed by ai-runner. The existing `InboxMessageDao` must satisfy the port structurally; no adapter class and no `ts-db` implementation changes are required. The existing DB-backed lifecycle test remains the integration proof, so `@gobing-ai/ts-db` remains available only as a development dependency.

Tasks 0040 and 0041 established the prerequisite optional-peer and inbox lifecycle work and are complete. This task is limited to `packages/ai-runner` source, tests, package metadata, and README documentation. It must not change inbox persistence behavior, delivery semantics, event emission, or public `ts-db` APIs.

### Requirements

R1. Add and export an ai-runner-owned `MessageStore` interface with exactly the operations consumed by `TeamOrchestrator`: enqueue a message, drain pending messages for a recipient, mark a message delivered, and mark a message failed.

R2. Add and export a minimal read-only message view for drained messages containing only the fields ai-runner consumes; do not expose or duplicate the full `InboxMessage` persistence model.

R3. Change `TeamOrchestrator` to depend on `MessageStore` and preserve its current enqueue, drain, delivery, failure, and reply-correlation behavior.

R4. Change message formatting helpers to consume the ai-runner-owned message view so production source under `packages/ai-runner/src` has no direct `@gobing-ai/ts-db` imports for message access.

R5. Keep `InboxMessageDao` structurally assignable to `MessageStore` without an adapter class or changes to `ts-db`.

R6. Move `@gobing-ai/ts-db` from ai-runner runtime dependencies to development dependencies because only integration tests require the concrete DB implementation after the port is introduced.

R7. Update unit tests so in-memory stores implement `MessageStore` directly and no unsafe constructor casts are needed; retain an integration assertion that the real `InboxMessageDao` satisfies the port and preserves lifecycle behavior.

R8. Update `packages/ai-runner/README.md` to document `MessageStore` as the orchestration boundary and `InboxMessageDao` as one structural provider.

R9. Make no changes to message persistence schema, lifecycle event semantics, orchestration behavior, or public `ts-db` APIs.

### Acceptance Criteria

#### Scenario: Orchestrator depends on the owned port

- Given a store that implements the ai-runner-owned `MessageStore`
- When it is supplied to `TeamOrchestrator`
- Then the orchestrator compiles and performs enqueue, drain, delivery, failure, and reply-correlation flows without a concrete `InboxMessageDao` type or unsafe cast

#### Scenario: Concrete inbox DAO is structurally compatible

- Given an `InboxMessageDao` from `@gobing-ai/ts-db/inbox`
- When it is assigned or passed as a `MessageStore`
- Then TypeScript accepts it without an adapter and the existing DB-backed inbox lifecycle integration test passes

#### Scenario: Production message access is decoupled from ts-db

- Given the completed source changes under `packages/ai-runner/src`
- When source imports and package metadata are inspected and the package is built
- Then message-access source contains no direct `@gobing-ai/ts-db` import and `@gobing-ai/ts-db` is listed only as a development dependency

#### Scenario: Public documentation describes composition

- Given the updated ai-runner README and public exports
- When a consumer looks for the orchestration persistence boundary
- Then `MessageStore` is documented as the owned contract and `InboxMessageDao` is shown as a structural provider

#### Scenario: Repository gates remain green

- Given all implementation, test, metadata, and documentation changes
- When `bun run spur-check` and `bun run build` execute
- Then both commands pass with no skipped tests, new suppression directives, or unrelated file changes

### Design

Create `packages/ai-runner/src/message-store.ts` as the ownership boundary. It exports a minimal drained-message view and `MessageStore`. The port mirrors the subset already implemented by `InboxMessageDao`: `enqueue`, `drainPending`, `markDelivered`, and `markFailed`. Use read-only fields and a read-only drained collection where compatible so consumers cannot depend on persistence mutability.

`TeamOrchestrator` receives `MessageStore` through its existing constructor seam. `messages.ts` accepts the owned message view. Export both types from ai-runner's public barrel. No runtime adapter is introduced: TypeScript structural typing makes `InboxMessageDao` a valid provider, while in-memory tests can implement the same interface explicitly.

Once production source no longer imports `ts-db`, move `@gobing-ai/ts-db` from `dependencies` to `devDependencies`. Keep the existing TypeScript source-path mappings required by the DB-backed integration test; the production build already clears workspace source aliases and therefore verifies that runtime source is independent of `ts-db`.

Verification combines compile-time structural assignment, existing orchestration unit behavior, the DB-backed inbox lifecycle integration test, package documentation review, the canonical `bun run spur-check` gate, and `bun run build`.

### Plan

1. Add the ai-runner-owned message view and `MessageStore` interface, then export them from the package barrel.
2. Rewire `TeamOrchestrator` and message formatting to the owned types without changing runtime behavior.
3. Move `@gobing-ai/ts-db` to ai-runner development dependencies while retaining test-only TypeScript resolution.
4. Update in-memory and DB-backed tests to prove direct fake implementation and structural `InboxMessageDao` compatibility without unsafe casts.
5. Update the ai-runner README to describe the port/provider boundary and composition pattern.
6. Run focused ai-runner tests and type checking, then run `bun run spur-check`, `bun run build`, and inspect `git status` for intentional changes only.

### Solution
Introduced the ai-runner-owned `MessageStore` port and `DrainedMessage` view, rewired `TeamOrchestrator` and message formatting to the owned types, moved `@gobing-ai/ts-db` to a development dependency, and updated tests + README to reflect the boundary. No changes to inbox persistence, event semantics, or `ts-db` public APIs.

| File | What / Why |
|------|------------|
| `packages/ai-runner/src/message-store.ts:1` | New ownership boundary. Exports `DrainedMessage` (read-only `id` / `fromId` / `body`) and `MessageStore` (`enqueue` / `drainPending` / `markDelivered` / `markFailed`) — exactly the operations `TeamOrchestrator` consumes. R1, R2. |
| `packages/ai-runner/src/team-orchestrator.ts:1` | Drop `InboxMessageDao` import; depend on `MessageStore` from `./message-store`. Constructor seam (`packages/ai-runner/src/team-orchestrator.ts:36`) now typed `MessageStore`, so `ts-db` is no longer a production import. R3, R9. |
| `packages/ai-runner/src/messages.ts:1` | `formatMessage` takes `DrainedMessage`. Removes the last `@gobing-ai/ts-db/inbox` message-access import from production source. R4. |
| `packages/ai-runner/src/index.ts:11` | Re-export `./message-store` so the port is part of the public barrel. R1. |
| `packages/ai-runner/package.json:52` | Move `@gobing-ai/ts-db` from `dependencies` to `devDependencies`. Only the DB-backed integration test resolves the concrete DAO. R6. |
| `packages/ai-runner/tests/team-orchestrator.test.ts:6` | `MemoryDao implements MessageStore` directly; `drainPending` returns `DrainedMessage[]`; removed both `as never` casts (`:99`, `:138`). R7. |
| `packages/ai-runner/tests/messages.test.ts:1` | `baseMessage` typed `DrainedMessage`; removes the `@gobing-ai/ts-db/inbox` import. R4, R7. |
| `packages/ai-runner/tests/inbox-lifecycle-bus.test.ts:7` | Compile-time `InboxMessageDao → MessageStore` assignability assertion (`:26`) and runtime method-presence checks alongside the existing lifecycle test. R5, R7. |
| `packages/ai-runner/tests/message-store.test.ts:1` | New focused port test: minimal in-memory store satisfies `MessageStore`, `DrainedMessage` carries only `id` / `fromId` / `body`. Satisfies the `require-corresponding-test` spur rule. R1, R2. |
| `packages/ai-runner/README.md:28` | Document `MessageStore` as the orchestration boundary and `InboxMessageDao` as a structural provider (`:66`, `:181`, `:496`, `:563`, `:667`); note `ts-db` is dev-only; update the architecture diagram and code samples. R8. |

**Verification**

- `bun run lint` (Biome + per-package `tsc --noEmit`): clean.
- `bun run build`: all 8 packages build green.
- `bun run spur-check`: 1628 tests pass, both spur presets (`recommended-pre-check`, `recommended-post-check`) pass with no warnings.
- `rg '@gobing-ai/ts-db' packages/ai-runner/src` → only a doc-comment mention in `packages/ai-runner/src/message-store.ts:5`; no runtime import.
- `rg '@gobing-ai/ts-db' packages/ai-runner/dist` → only doc-comment references; no runtime import in emitted JS.
- `git status`: intentional changes only (ai-runner source/tests/README/package.json, `bun.lock`, task file).

No partial deliverable — all R-items shipped in this task.
### Testing
**Requirements Traceability**

| Req | Status | Evidence |
|-----|--------|----------|
| R1 — ai-runner-owned `MessageStore` with `enqueue` / `drainPending` / `markDelivered` / `markFailed` | MET | `packages/ai-runner/src/message-store.ts:26` declares the interface with exactly those four operations; re-exported from `packages/ai-runner/src/index.ts:9`; exercised by `packages/ai-runner/tests/message-store.test.ts:15` and `packages/ai-runner/tests/team-orchestrator.test.ts:17`. |
| R2 — minimal read-only `DrainedMessage` (`id`, `fromId`, `body`) | MET | `packages/ai-runner/src/message-store.ts:14` declares `readonly id` / `readonly fromId` / `readonly body` only; `Object.keys(drained).sort()` assertion at `packages/ai-runner/tests/message-store.test.ts:22`. |
| R3 — `TeamOrchestrator` depends on `MessageStore`; behavior preserved | MET | Constructor seam `packages/ai-runner/src/team-orchestrator.ts:37` typed `MessageStore`; no `InboxMessageDao`/`ts-db` import remains (`rg` clean); `bunx tsc --noEmit` exit 0; full suite 1628 pass. |
| R4 — formatting consumes the owned view; no direct `ts-db` import under `src/` | MET | `packages/ai-runner/src/messages.ts:4` takes `DrainedMessage`; `rg "from '@gobing-ai/ts-db" packages/ai-runner/src/` → no matches. |
| R5 — `InboxMessageDao` structurally assignable to `MessageStore` (no adapter, no `ts-db` change) | MET | Compile-time proof `packages/ai-runner/tests/inbox-lifecycle-bus.test.ts:10` (`(dao: InboxMessageDao) => MessageStore = (dao) => dao`); runtime method-presence checks `:51`; no `packages/db/` change in `git status`. |
| R6 — `@gobing-ai/ts-db` moved from `dependencies` to `devDependencies` | MET | `jq '{dependencies,devDependencies}' package.json` → `@gobing-ai/ts-db` present only under `devDependencies`, absent from `dependencies`. |
| R7 — in-memory stores implement `MessageStore` directly; no unsafe casts; integration lifecycle assertion retained | MET | `packages/ai-runner/tests/team-orchestrator.test.ts:17` `class MemoryDao implements MessageStore`; `drainPending` returns `DrainedMessage[]` (`:42`); zero `as never`/`as any`/`as unknown` in the four task-scoped test files; DB-backed lifecycle test `inbox-lifecycle-bus.test.ts` retains `message.enqueued`/`message.delivered` bus assertions and passes. |
| R8 — README documents the port/provider boundary | MET | `packages/ai-runner/README.md:29` (port/view row), `:66-72` architecture diagram, `:183` design notes, `:498-516` durable-messages section, `:565-585` orchestrator example, `:667` boundary note (ts-db dev-only). |
| R9 — no schema / lifecycle-event / orchestration-behavior / `ts-db`-API changes | MET | `git status` shows no `packages/db/` changes; only ai-runner source/tests/README/package.json, `bun.lock`, and the task file changed; `bun run spur-check` 1628 pass / 0 fail. |

**Acceptance Criteria Verification**

| AC | Status | Evidence Type | Evidence |
|----|--------|--------------|----------|
| Scenario: Orchestrator depends on the owned port | MET | test | `packages/ai-runner/tests/team-orchestrator.test.ts` constructs `TeamOrchestrator` with a `MemoryDao implements MessageStore` and exercises enqueue/drain/delivery/failure/reply-correlation; `bunx tsc --noEmit` exit 0 (no cast); suite passes. |
| Scenario: Concrete inbox DAO is structurally compatible | MET | static-ref + test | `packages/ai-runner/tests/inbox-lifecycle-bus.test.ts:10` compile-time `InboxMessageDao → MessageStore` assignment; `:42` constructs a real `InboxMessageDao` against `BunSqliteAdapter`; DB-backed integration test passes. |
| Scenario: Production message access is decoupled from ts-db | MET | command | `rg "from '@gobing-ai/ts-db" packages/ai-runner/src/` → none; `@gobing-ai/ts-db` only under `devDependencies`; `rg "require\(.@gobing-ai/ts-db\|from .@gobing-ai/ts-db" packages/ai-runner/dist/` → no runtime import (only doc-comment strings); `bun run build` exit 0. |
| Scenario: Public documentation describes composition | MET | static-ref | `packages/ai-runner/README.md:498-505` documents `MessageStore` as the owned boundary and `InboxMessageDao` as one structural provider; `:66-72` diagram; `:183` design notes. |
| Scenario: Repository gates remain green | MET | command | `bun run spur-check` → 1628 pass / 0 fail, both presets clean (`recommended-pre-check`, `recommended-post-check`: `coverage-gate` ✓, `every-export-has-tsdoc` ✓), no skipped tests, no `biome-ignore`; `bun run build` → all 8 packages exit 0. |

**Design Conformance**

| Check | Status | Evidence |
|-------|--------|----------|
| design-conformance | pass | 5/5 design claims DONE — port module + minimal view (`message-store.ts:14,26`), `TeamOrchestrator` constructor seam (`team-orchestrator.ts:37`), `messages.ts` consumes owned view (`messages.ts:4`), barrel re-export (`index.ts:9`), dev-dependency move with retained test-only TS resolution (`package.json` devDependencies). No CHANGED deviations; no scope-creep — every diff hunk traces to an R-item. |

**SECUA Review**

| Dimension | Findings |
|-----------|----------|
| Security | None. Structural typing only; no secrets, no new untrusted-input handling. |
| Efficiency | None. `DrainedMessage` is a structural narrowing; producers returning `InboxMessage[]` satisfy the port covariantly with no runtime projection cost. |
| Correctness | None. Port signatures match `InboxMessageDao` exactly; assignability verified at compile-time (`tsc` exit 0) and runtime (method-presence checks). |
| Usability | None. `DrainedMessage` is minimal and fully read-only. |
| Architecture | Advisory: `DrainedMessage` omits `toId`/`inReplyTo`; if a future consumer needs either, widen the view in a follow-up rather than casting. Not a blocker. |

**Verification commands run this turn (verify pass)**

- `rg "from '@gobing-ai/ts-db" packages/ai-runner/src/` → no matches (R4).
- `bunx tsc --noEmit` (ai-runner) → exit 0.
- `bun run spur-check` → 1628 pass / 0 fail; both spur presets clean.
- `bun run build` → all 8 packages exit 0.
- `rg "…@gobing-ai/ts-db" packages/ai-runner/dist/` → no runtime import (doc-comment strings only).
- `spur task check 0045 --strict-core` → PASS (only the deferral-valid `feature_id` WARN).

Coverage: satisfied by the existing ai-runner suite plus the new `tests/message-store.test.ts`; the spur `coverage-gate` post-check rule passed this run.

**Verdict: PASS** — all 9 requirements MET, all 5 AC MET, design conformance 5/5, no blocker/major SECUA findings. `--fix all` had no UNMET/PARTIAL items or major findings to repair.
### Review

**Functional Traceability** (skill: `sp-functional-review`)

All 9 R-items MET. Every diff hunk traces to a requirement — no orphan code.

| Req | Verdict | Evidence |
|-----|---------|----------|
| R1 MessageStore port | MET | `packages/ai-runner/src/message-store.ts:20` (4 ops), re-export `packages/ai-runner/src/index.ts:11` |
| R2 DrainedMessage view | MET | `packages/ai-runner/src/message-store.ts:10` (3 readonly fields) |
| R3 TeamOrchestrator uses port | MET | seam `packages/ai-runner/src/team-orchestrator.ts:36` |
| R4 no ts-db in src | MET | `rg "from '@gobing-ai/ts-db" packages/ai-runner/src/` → none (run this turn) |
| R5 InboxMessageDao structurally assignable | MET | sigs match exactly: `packages/db/src/inbox-message-dao.ts:97,121,156,173`; compile-time assert `tests/inbox-lifecycle-bus.test.ts:7` |
| R6 ts-db → devDependencies | MET | `packages/ai-runner/package.json` |
| R7 in-memory stores implement MessageStore; no casts | MET | `tests/team-orchestrator.test.ts` `class MemoryDao implements MessageStore` |
| R8 README updated | MET | `packages/ai-runner/README.md` |
| R9 no schema/lifecycle/ts-db changes | MET | `git status` shows no `packages/db/` changes |

**SECUA Review** (skill: `sp-code-verification`, review mode)

| Dimension | Severity | Finding |
|-----------|----------|---------|
| Security | — | None. No secrets, no untrusted input paths, no injection surface. Pure type-boundary change. |
| Efficiency | — | None. `DrainedMessage` is a covariant return-type projection; no per-call allocation added. `InboxMessage[]` still flows at runtime — map is identity. |
| Correctness | — | None. Signatures match `InboxMessageDao` verbatim (`enqueue ⇒ Promise<string>`, `drainPending ⇒ Promise<DrainedMessage[]>`, `markDelivered/markFailed ⇒ Promise<void>`). Structural assignability verified compile-time + runtime. |
| Usability | — | None. `DrainedMessage` minimal + readonly. Consumers cannot reach persistence mutability through the view. |
| Architecture | advisory | `DrainedMessage` intentionally omits `toId`/`inReplyTo`. If a future consumer needs either, widen the view in a follow-up rather than casting at the call-site. Non-blocking. |

No blockers. No majors. One advisory.

**Architectural Depth** (skill: `sp-code-improvement`, 5 signals)

| Signal | Assessment |
|--------|------------|
| Shallow module | **HARDENED.** `message-store.ts` is a deliberate deep-module boundary (per ADR-023 A4) — 31 lines defining a port + view. It replaces the shallow implicit "import the concrete DAO" coupling with an explicitly named seam. Depth metric: the port hides persistence, schema, and DAO internals behind a 4-method interface. |
| Tight coupling | **REDUCED.** `TeamOrchestrator` no longer names `InboxMessageDao`/`ts-db` at all. Coupling moved from concrete-module to abstract-port (DIP). The structural-assignment test (`tests/inbox-lifecycle-bus.test.ts:7`) is the dependency-rule evidence — the port admits any concrete provider by shape, not by import. |
| Wrong seam | **CORRECTED.** Pre-A4, the seam lived in `ts-db` (the orchestrator imported a DAO from another package). Post-A4, the seam lives in `ts-ai-runner/src/message-store.ts` — the package that owns the orchestration policy owns the port. This is the ADR-023 "owned port" pattern. |
| Weak locality | **IMPROVED.** `DrainedMessage` lives next to its consumer (`messages.ts`, `team-orchestrator.ts`). Previously the orchestrator reached across package boundaries to deserialize `InboxMessage`. |
| Poor test surface | **IMPROVED.** In-memory stores (`MemoryDao`) `implements MessageStore` directly — no `as never` casts, no InboxMessage sprawl. New `tests/message-store.test.ts` exercises the port in isolation. Reduces test setup cost from "needs DB adapter" to "needs 4 stub methods." |

**Scope-creep / drift**: none. Every diff hunk traces to an R-item. No `ts-db` schema changes. No `packages/db/` edits at all.

**Anti-sycophancy / honesty check**: claims above cite commands run **this turn** (`bun run build` 8/8 green, `bun test packages/ai-runner` 138 pass / 0 fail, `rg ts-db src/` → none, `spur task check --strict-core` PASS). No stale "passed last run" evidence.

Verdict: **PASS** — no blockers, no majors, one advisory (non-blocking).

### History

- 2026-07-13T16:54:38.864Z backlog → todo (system)
- 2026-07-13T18:15:29.400Z todo → wip (system)
- 2026-07-13T18:15:29.585Z wip → testing (system)
- 2026-07-13T20:32:41.981Z testing → done (system)
