---
schema_version: 1
name: Implement team mode primitives in ts-ai-runner and ts-db
description: Implement team mode primitives in ts-ai-runner and ts-db for Spur team mode Phases 1-4
status: done
type: task
priority: P1
tags: [team-mode,feature,ts-ai-runner,ts-db,identity,messaging]
dependencies: [@gobing-ai/ts-db 0.2.4 (inbox_messages table),@gobing-ai/ts-ai-runner 0.2.5 (AiRunner base)]
created_at: 2026-06-02T17:55:06.281Z
updated_at: 2026-06-02T18:35:52.558Z
---

## 0005. Implement team mode primitives in ts-ai-runner and ts-db

### Background

Spur team mode (`docs/design/spur-team-mode-design.md` in the spur-new repo) requires new
primitives in `ts-ai-runner` and `ts-db`:

- **Identity preamble** — auto-generated "you are agent X, your peers are Y" blocks injected
  into agent system prompts.
- **Durable message queue** — an `inbox_messages` table + DAO for persistent inter-agent
  communication with live stdin injection and deferred drain.
- **Persistent agent process** — a `TeamAgentProcess` class that spawns and manages
  long-running coding agent subprocesses.
- **Team orchestrator** — a `TeamOrchestrator` that manages the lifecycle of multiple agents
  (load specs, start/stop, route messages, drain inboxes).
- **Agent spec config** — an `AgentSpec` type with YAML load/save for defining agents as code.

This task implements all ts-libs-side changes needed for Spur team mode Phases 1-4.
The Spur CLI and app layer (commands, services, HTTP API, dashboard) are implemented
separately in the spur-new repo.

### Requirements

**R1** — `ts-db`: `inbox_messages` table + `InboxMessageDao`.

Follow the same `defineTable` pattern as `queue_jobs` (ADR-005: drizzle internal to ts-db).
Schema:

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY |
| `from_id` | TEXT | nullable (null = operator) |
| `to_id` | TEXT | NOT NULL |
| `body` | TEXT | NOT NULL |
| `status` | TEXT | DEFAULT 'queued' |
| `in_reply_to` | TEXT | nullable |
| `created_at` | INTEGER | NOT NULL |
| `delivered_at` | INTEGER | nullable |
| `inject_attempts` | INTEGER | DEFAULT 0 |
| `inject_error` | TEXT | nullable |

Index: `CREATE INDEX idx_inbox_messages_to_status ON inbox_messages(to_id, status)`.

`InboxMessageDao extends EntityDao<typeof inboxMessages, string>`:

- `enqueue(fromId, toId, body, inReplyTo?): Promise<string>` — INSERT + RETURNING id.
- `drainPending(toId): Promise<InboxMessage[]>` — SELECT WHERE to_id = ? AND status = 'queued'
  → UPDATE SET status = 'injected', inject_attempts = inject_attempts + 1 → RETURNING *.
- `markDelivered(msgId): Promise<void>` — UPDATE status = 'delivered', delivered_at = now().
- `markFailed(msgId, error): Promise<void>` — UPDATE status = 'failed', inject_error = ?.
- `inbox(toId, limit?, offset?): Promise<InboxMessage[]>` — SELECT WHERE to_id = ?
  ORDER BY created_at DESC.
- `countPending(toId): Promise<number>` — SELECT COUNT(*) WHERE to_id = ? AND status = 'queued'.

Exported from `@gobing-ai/ts-db/inbox` subpath. Add to `package.json` exports.

**R2** — `ts-ai-runner`: `IdentityPreamble` module (`src/identity.ts`).

Pure function — no side effects, no DB access, no subprocess calls:

```typescript
export interface IdentityContext {
    agentId: string;
    agentType: string;
    workspace: string;
    purpose?: string;
    taskId?: string;
    taskTitle?: string;
    systemPrompt?: string;
    peers?: Array<{ id: string; type: string; purpose?: string }>;
    gitBranch?: string;
    gitDirty?: boolean;
    guardrails?: string[];
}

export function buildIdentityPreamble(ctx: IdentityContext): string;
```

Composes:
1. Identity line: `You are agent \`<id>\` (<type>) in workspace \`<ws>\`.`
2. Task line (if taskId): `Your current task: #<taskId> — <taskTitle>.`
3. Purpose line (if purpose): `Your purpose: <purpose>.`
4. System prompt (if systemPrompt): rendered verbatim.
5. Peer list (if peers.length > 0): `Peer agents in this workspace:` with per-peer
   `- \`<id>\` (<type>) — <purpose or '(no purpose set)'>`.
6. Communication instructions: `spur message send`, `spur message reply`, `spur message inbox`.
7. Git context (if branch): branch name, dirty flag.
8. Guardrails (if guardrails): rendered as bullet list.

`getGitContext(workspacePath: string): string | null` — helper using `Bun.which('git')` +
`Bun.spawnSync` for `git branch --show-current` and `git status --porcelain`.

**R3** — `ts-ai-runner`: Extend `PromptOptions` and `AiRunner.run()`.

```typescript
export interface PromptOptions {
    input?: string;
    continue?: boolean;
    model?: string;
    mode?: 'text' | 'json';
    // NEW — all optional, backward compatible
    purpose?: string;
    tags?: string[];
    systemPrompt?: string;
    taskId?: string;
    peers?: Array<{ id: string; type: string; purpose?: string }>;
}
```

In `AiRunner.run()`: when any of `purpose`, `systemPrompt`, `taskId`, `peers` is present,
compose identity preamble and prepend to the prompt before dispatch via the existing
per-harness mechanism. `AgentShim.getPromptCommand()` passes through new options.

Backward compatible: all new fields are optional; existing callers (Spur `agent run`,
any other consumer) compile and pass tests unchanged.

**R4** — `ts-ai-runner`: `AgentSpec` type + load/save.

```typescript
export interface AgentSpec {
    id: string;
    name: string;
    type: string;
    workspace: string;
    purpose: string;
    tags: string[];
    config: Record<string, unknown>;       // model, autonomy, systemPrompt, etc.
    autoStart?: boolean;
}

export function loadAgentSpecs(configDir: string): AgentSpec[];
export function saveAgentSpec(spec: AgentSpec, configDir: string): Promise<void>;
export function deleteAgentSpec(id: string, configDir: string): Promise<void>;
export function validateAgentId(id: string): string;  // throws ValueError on invalid
```

YAML format matching `docs/design/spur-team-mode-design.md` Section 4.1. Use `Bun.file()`
+ `yaml` package (or inline parser — YAML subset: strings, arrays, objects, no anchors).

**R5** — `ts-ai-runner`: `MessageService` class.

```typescript
export class MessageService {
    constructor(private dao: InboxMessageDao);

    async enqueue(fromId: string | null, toId: string, body: string,
                  inReplyTo?: string): Promise<string>;
    async drain(toId: string): Promise<InboxMessage[]>;
    async deliver(msgId: string): Promise<void>;
    async fail(msgId: string, error: string): Promise<void>;
    async inbox(toId: string, limit?: number, offset?: number): Promise<InboxMessage[]>;
    async countPending(toId: string): Promise<number>;

    static formatMessage(msg: InboxMessage): string;
    // Returns: "[task from=<fromId or 'operator'> id=<msg.id>] <msg.body>"
}
```

Zero dependency on subprocess/PTY — pure DB operations. The live stdin injection
happens in `TeamOrchestrator` (R7), not here.

**R6** — `ts-ai-runner`: `TeamAgentProcess` class.

Wraps a persistent coding agent subprocess:

```typescript
export interface AgentProcessOptions {
    spec: AgentSpec;
    command: string[];
    env?: Record<string, string>;
    cwd?: string;
}

export class TeamAgentProcess {
    readonly agentId: string;
    readonly identityPreamble: string;

    constructor(options: AgentProcessOptions);

    start(): Promise<void>;
    // Spawns via Bun.spawn in pipe mode (stdin: 'pipe', stdout: 'pipe', stderr: 'pipe').

    stop(): Promise<void>;
    // SIGTERM → wait 5s → SIGKILL.

    send(message: string): Promise<{ ok: boolean }>;
    // Writes formatted message + '\n' to subprocess stdin.

    subscribe(callback: (data: Buffer) => void): () => void;
    // Returns unsubscribe function.

    getStatus(): 'running' | 'stopped' | 'errored';
    getPid(): number | null;
    getExitCode(): number | null;
}
```

No PTY requirement for Phase 1-4. Pipe mode works for: claude `-p`, codex `exec`,
pi `-p`, gemini `-p`. PTY support deferred to Phase 5 (team mode dashboard).

**R7** — `ts-ai-runner`: `TeamOrchestrator` class.

```typescript
export class TeamOrchestrator {
    constructor(configDir: string, messageService: MessageService);

    // Spec management
    loadSpecs(): AgentSpec[];
    getSpec(id: string): AgentSpec | undefined;

    // Lifecycle
    async startAgent(id: string): Promise<TeamAgentProcess>;
    // 1. loadSpec(id) → AgentSpec
    // 2. detect agent type → AgentShim
    // 3. build command via shim.getPromptCommand() with purpose/peers
    // 4. create TeamAgentProcess
    // 5. call .start()
    // 6. drain pending messages via MessageService
    // 7. emit 'agent.started' event

    async stopAgent(id: string): Promise<void>;
    async restartAgent(id: string): Promise<TeamAgentProcess>;

    // Messaging
    async sendMessage(fromId: string | null, toId: string, body: string,
                      inReplyTo?: string): Promise<string>;
    // 1. enqueue to DB (durable)
    // 2. if target is running → live stdin injection
    // 3. return msgId

    // Queries
    getRunningAgents(): Map<string, TeamAgentProcess>;
    getAgentStatus(id: string): 'running' | 'stopped' | 'errored' | 'unknown';
    getPeerSpecs(workspace: string, excludeId?: string): AgentSpec[];
    // For identity preamble composition.

    // Shutdown
    async stopAll(): Promise<void>;
}
```

**R8** — Tests and coverage.

- R8.1: `InboxMessageDao` tests via in-memory SQLite — enqueue, drain, deliver, fail,
  inbox, count, concurrent enqueue.
- R8.2: `IdentityPreamble` tests — solo agent, agent with task, agent with peers,
  agent with purpose + guardrails, agent with git context, empty peers, missing optional fields.
- R8.3: `MessageService` tests — enqueue → drain → deliver cycle, formatMessage output,
  countPending accuracy.
- R8.4: `TeamAgentProcess` tests — mock subprocess via `Bun.spawn` with `echo`-like command,
  start/stop/send/subscribe lifecycle, signal handling, exit code propagation.
- R8.5: `TeamOrchestrator` tests — mock TeamAgentProcess, verify drain on start,
  verify live injection on sendMessage, verify stopAll.
- R8.6: Integration test — full round-trip: create agent spec → start → send message →
  drain inbox → verify message content.
- R8.7: `AgentSpec` tests — load/save/delete round-trip, validate id format, duplicate detection.
- R8.8: Coverage ≥ 90% line, ≥ 90% function (ts-libs standard).

**R9** — No breaking changes.

- R9.1: All existing `AiRunner.run()` callers compile and pass tests unchanged.
- R9.2: All existing ts-db exports unchanged; `inbox_messages` is additive.
- R9.3: All existing ts-ai-runner exports unchanged; new exports are additive.
- R9.4: `bun run spur-check` green across all packages before and after.

### Design

#### Module layout

```
packages/db/
  src/schema/
    inbox-messages.ts         ← defineTable('inbox_messages', { ...standardColumns })
    index.ts                  ← add inboxMessages to exports
  src/dao/
    inbox-message-dao.ts      ← InboxMessageDao extends EntityDao
    index.ts                  ← add InboxMessageDao to exports
  src/index.ts                ← re-export from subpaths unchanged
  package.json                ← add "./inbox" exports subpath

packages/ai-runner/
  src/
    identity.ts               ← buildIdentityPreamble, getGitContext, IdentityContext
    agent-spec.ts             ← AgentSpec, loadAgentSpecs, saveAgentSpec, validateAgentId
    message-service.ts        ← MessageService
    team-agent-process.ts     ← TeamAgentProcess, AgentProcessOptions
    team-orchestrator.ts      ← TeamOrchestrator
    index.ts                  ← re-export all new types + classes
  tests/
    identity.test.ts
    agent-spec.test.ts
    message-service.test.ts
    team-agent-process.test.ts
    team-orchestrator.test.ts
```

#### Dependency graph

```
ts-ai-runner
  ├── ts-db/inbox (InboxMessageDao type only, for MessageService)
  ├── ts-infra (for logging, optional EventBus stubs)
  └── ts-runtime (for ProcessExecutor, FileSystem)

ts-db
  └── (no new deps; inbox_messages is additive)
```

#### Identity preamble output example

```
You are agent `coder` (claude-code) in workspace `spur-new`.
Your current task: #0005 — Implement JWT auth with refresh tokens.
Your purpose: Implement scoped code changes as directed by `planner`.

Peer agents in this workspace:
  - `planner` (claude-code) — Produce implementation plans from requirements.
  - `reviewer` (codex-cli) — Review PRs for correctness, security, and style.

Communication — to send a message to a peer, use:
  spur message send --to <agent-id> "<message>"
To reply to a message, use:
  spur message reply <msg-id> "<response>"

Git context:
  branch: feat/auth-module
  dirty: 3 files

Guardrails:
  - You are not authorized to commit code.
  - You are not authorized to modify docs/tasks/ files.
```

### Plan

#### Phase 1 — ts-db: inbox_messages table + InboxMessageDao

1. Create `packages/db/src/schema/inbox-messages.ts` with `defineTable('inbox_messages', ...)`.
2. Add `inboxMessages` to `packages/db/src/schema/index.ts` exports.
3. Create `packages/db/src/dao/inbox-message-dao.ts` with `InboxMessageDao extends EntityDao`.
4. Add DAO methods: `enqueue`, `drainPending`, `markDelivered`, `markFailed`, `inbox`, `countPending`.
5. Add `InboxMessageDao` to `packages/db/src/dao/index.ts` exports.
6. Add `"./inbox"` subpath to `packages/db/package.json` exports.
7. Create `packages/db/tests/dao/inbox-message-dao.test.ts` covering all DAO methods.

#### Phase 2 — ts-ai-runner: IdentityPreamble

8. Create `packages/ai-runner/src/identity.ts`.
9. Implement `buildIdentityPreamble()` with all 8 sections from the design.
10. Implement `getGitContext()` helper using `Bun.spawnSync`.
11. Create `packages/ai-runner/tests/identity.test.ts` covering all field combinations.

#### Phase 3 — ts-ai-runner: AgentSpec + PromptOptions extension

12. Add `purpose?`, `tags?`, `systemPrompt?`, `taskId?`, `peers?` to `PromptOptions`.
13. In `AiRunner.run()`: compose identity preamble when relevant fields present.
14. Create `packages/ai-runner/src/agent-spec.ts` with types + load/save/validate.
15. Create `packages/ai-runner/tests/agent-spec.test.ts`.
16. Update existing ai-runner tests to verify PromptOptions backward compat.

#### Phase 4 — ts-ai-runner: MessageService

17. Create `packages/ai-runner/src/message-service.ts`.
18. Implement `MessageService` wrapping `InboxMessageDao` (dependency injection).
19. Implement `formatMessage()` static method.
20. Create `packages/ai-runner/tests/message-service.test.ts` with in-memory SQLite.

#### Phase 5 — ts-ai-runner: TeamAgentProcess + TeamOrchestrator

21. Create `packages/ai-runner/src/team-agent-process.ts`.
22. Implement spawn/stop/send/subscribe with `Bun.spawn` (pipe mode).
23. Create `packages/ai-runner/src/team-orchestrator.ts`.
24. Implement startAgent (drain on start), sendMessage (live inject), stopAll.
25. Create `packages/ai-runner/tests/team-agent-process.test.ts` with mock processes.
26. Create `packages/ai-runner/tests/team-orchestrator.test.ts` with mock TeamAgentProcess.

#### Phase 6 — Verify and publish

27. `bun run spur-check` green across all packages.
28. `bun run build` green.
29. Verify no breaking changes: existing spur-new code compiles against the updated packages.
30. Bump version + publish (operator-run via `bun run bump-ver`).

### References

- Spur repo: `docs/design/spur-team-mode-design.md` — Full team mode design
- Spur repo: `docs/analysis/relaydeck-vs-spur-analysis.md` — relaydeck messaging architecture
- `packages/db/src/schema/queue-jobs.ts` — Reference pattern for entity table definition
- `packages/db/src/dao/queue-job-dao.ts` — Reference pattern for EntityDao subclass
- `packages/ai-runner/src/ai-runner.ts` — AiRunner.run() current implementation
- `packages/ai-runner/src/slash-command.ts` — Existing extension pattern
- `packages/ai-runner/src/index.ts` — Current public API surface
- `docs/00_ADR.md` — ADR-005 (drizzle internal), ADR-006 (engine boundaries)

### Solution

- Implemented additive inbox persistence in `packages/db`: `inbox_messages` schema, embedded migrations, `InboxMessageDao`, main-barrel exports, and the `@gobing-ai/ts-db/inbox` subpath.
- Implemented team-mode primitives in `packages/ai-runner`: identity preamble composition, agent spec persistence, `MessageService`, `TeamAgentProcess`, and `TeamOrchestrator`.
- Extended `PromptOptions` backward-compatibly. Identity preambles are prepended only when `purpose`, `systemPrompt`, `taskId`, or non-empty `peers` are supplied.
- Kept runtime-sensitive operations behind `@gobing-ai/ts-runtime` seams to satisfy repository rules: sync filesystem, sync process execution, and persistent pipe process spawning.
- Added source path/dependency updates for packages that typecheck aliased source surfaces affected by the new `ts-db` dependency.
- Covered the new behavior with focused Bun tests across `ts-db`, `ts-ai-runner`, and `ts-runtime`.

### Review

Verdict: PASS.

- Requirements traceability: R1-R7 are implemented as additive public surfaces; R8 coverage is satisfied by focused tests and repository coverage gate; R9 is preserved through optional `PromptOptions` fields and passing full type/build gates.
- Architecture: `drizzle-orm` usage remains contained in `ts-db`; `ts-ai-runner` consumes only the `@gobing-ai/ts-db/inbox` facade. Direct filesystem/process APIs are kept behind `ts-runtime` seams per the Spur runtime-boundary rules.
- Compatibility: existing `AiRunner.runPromptCommand()` call shape remains valid; identity preamble injection is opt-in by presence of team-mode fields.
- Residual risk: `AgentSpec` intentionally implements the constrained YAML subset required by this task, not full YAML anchors/tags/multiline scalar support.

#### Forced verification — 2026-06-02T19:18:00-07:00

Verdict: PASS after fix-all.

Findings fixed:

- Correctness: identity preamble task and peer lines now use the required em dash separator from R2.
- Correctness/API consistency: `BunSyncProcessExecutor.runSync()` now honors `rejectOnError: true`, matching the async process executor contract.

SECU result:

| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| - | No remaining findings | Security/Efficiency/Correctness/Usability | Task scope | None |

Traceability result: R1-R9 remain satisfied after the fix pass.

### Testing

- Timestamp: 2026-06-02T19:05:00-07:00.
- Command: `biome check packages/runtime packages/db packages/ai-runner packages/rule-engine`
  - Result: PASS.
- Command: `bun run typecheck` in `packages/runtime`, `packages/db`, `packages/ai-runner`, and `packages/rule-engine`
  - Result: PASS.
- Command: `bun run test` in `packages/runtime`, `packages/db`, and `packages/ai-runner`
  - Result: PASS. `ts-db`: 170 tests; `ts-ai-runner`: 50 tests; `ts-runtime`: 37 tests.
- Command: `bun run spur-check`
  - Result: PASS. Biome, workspace typecheck, Spur pre-check, full test suite with coverage, and Spur coverage gate all passed. Full suite: 837 tests, 0 failures, coverage all files 98.98% functions / 99.51% lines.
- Command: `bun run build`
  - Result: PASS. All workspace packages built successfully.
- Command: `bun run spur-check` after forced verification fix pass
  - Result: PASS. Full suite: 838 tests, 0 failures, coverage all files 98.98% functions / 99.51% lines.
- Command: `bun run build` after forced verification fix pass
  - Result: PASS. All workspace packages built successfully.


### History

- Migrated from legacy format (2026-07-31)
