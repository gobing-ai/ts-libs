# @gobing-ai/ts-ai-runner

Coding-agent command shims, installation detection, doctor checks, slash-command translation, and prompt execution for downstream CLIs.

## What It Provides

`ts-ai-runner` normalizes the command-line surface of common coding agents so application code can work with stable TypeScript APIs instead of hard-coded executable arguments.

| Export | Purpose |
|--------|---------|
| `AiRunner` | Runs help, version, auth, prompt, and slash commands through a pluggable process executor; can also build a prompt command without executing it |
| `AgentDetector` | Probes supported agent CLIs and parses version output |
| `DoctorRunner` | Combines installation and authentication checks into a usability report |
| `getAgentShim()` | Returns the pure command builder for one supported agent |
| `translateSlashCommand()` | Converts Claude-style `/plugin:command` inputs to each agent's dialect |
| `buildIdentityPreamble()` | Builds team-mode identity and communication context for prompts |
| `loadAgentSpecs()` / `saveAgentSpec()` | Persist agent definitions as YAML-compatible config |
| `MessageService` | Thin service wrapper around `@gobing-ai/ts-db/inbox` |
| `TeamAgentProcess` | Manages a long-running agent subprocess with pipe-mode stdin/stdout |
| `TeamOrchestrator` | Loads specs, starts/stops agents, and routes durable/live messages |

Supported agent identifiers are `claude`, `codex`, `gemini`, `pi`, `opencode`, `antigravity`, and `openclaw`.

## Installation

```bash
bun add @gobing-ai/ts-ai-runner
```

The package depends on `@gobing-ai/ts-runtime` for process execution, `@gobing-ai/ts-db` for team-mode inbox types, and `@gobing-ai/ts-infra` for structured logging. The target agent CLIs are not bundled; install them separately in the host environment.

## Detect Installed Agents

```ts
import { AgentDetector } from '@gobing-ai/ts-ai-runner';

const detector = new AgentDetector({ timeout: 5_000 });
const agents = await detector.detectAll();

for (const agent of agents) {
    console.log(agent.name, agent.installed, agent.version, agent.error);
}
```

Probe a single agent when you already know the target:

```ts
const codex = await detector.detectOne('codex');
if (!codex.installed) {
    throw new Error(codex.error ?? 'codex is not installed');
}
```

Unknown agent names are reported as unavailable rather than throwing.

## Run Agent Commands

```ts
import { AiRunner } from '@gobing-ai/ts-ai-runner';

const runner = new AiRunner({
    defaultCwd: '/workspace/project',
    defaultTimeout: 60_000,
});

const result = await runner.runPromptCommand('codex', {
    input: 'Review packages/runtime/src/fs.ts',
    model: 'gpt-5',
    mode: 'text',
});

if (result.exitCode !== 0) {
    throw new Error(result.stderr);
}

console.log(result.stdout);
```

`AiRunner` captures `stdout`, `stderr`, `exitCode`, optional termination `signal`, and `durationMs`. It does not throw on non-zero agent exits; callers decide how to handle failures.

Every invocation is logged through an injectable logger (`getLogger('ai-runner')` by default): one `debug` line per dispatch and an `error` line on any non-zero exit. Pass a custom `logger` to the constructor to route diagnostics elsewhere or silence them in tests.

### Slash commands and command preview

`runSlashCommand()` translates a Claude-style `/plugin:command args` input into the target agent's dialect (via `translateSlashCommand()`) and dispatches it as a prompt. Non-slash input passes through unchanged.

```ts
// For codex, "/review:pr 123" becomes "$review-pr 123" before dispatch.
await runner.runSlashCommand('codex', '/review:pr 123', { model: 'gpt-5' });
```

`buildPromptCommand()` returns the resolved `{ command, args }` **without** executing it — useful for previewing, logging, or dry-running the exact argv a prompt would dispatch. It applies the same identity-preamble enrichment as `runPromptCommand()`.

```ts
const { command, args } = runner.buildPromptCommand('pi', { input: 'ship it', mode: 'json' });
// command === 'pi', args === ['--no-session', '-p', 'ship it', '--mode', 'json']
```

### Team identity preambles

`PromptOptions` accepts optional team-mode fields. When any of `purpose`, `systemPrompt`, `taskId`,
or non-empty `peers` is supplied, `AiRunner` prepends an identity preamble before dispatching the
prompt through the selected agent shim. Existing callers that only pass `input`, `continue`, `model`,
or `mode` are unchanged.

```ts
await runner.runPromptCommand('codex', {
    input: 'Implement the inbox DAO tests',
    taskId: '0005',
    purpose: 'Implement scoped code changes',
    systemPrompt: 'Follow repository AGENTS.md rules.',
    peers: [{ id: 'planner', type: 'claude', purpose: 'Plan implementation work' }],
});
```

Use `buildIdentityPreamble()` directly when a host app needs to preview or inject the same context
outside `AiRunner`:

```ts
import { buildIdentityPreamble } from '@gobing-ai/ts-ai-runner';

const preamble = buildIdentityPreamble({
    agentId: 'coder',
    agentType: 'codex',
    workspace: '/workspace/spur',
    taskId: '0005',
    taskTitle: 'Implement team mode primitives',
    purpose: 'Make focused code changes',
    peers: [{ id: 'reviewer', type: 'claude', purpose: 'Review correctness and risk' }],
    guardrails: ['Do not commit without operator approval.'],
});
```

## Inject a Process Executor

For tests, dry runs, or sandboxed launchers, inject a `ProcessExecutor` from `@gobing-ai/ts-runtime`:

```ts
import type { ProcessExecutor } from '@gobing-ai/ts-runtime';
import { AiRunner } from '@gobing-ai/ts-ai-runner';

const processExecutor: ProcessExecutor = {
    async run(options) {
        return {
            exitCode: 0,
            stdout: `${options.command} ${options.args.join(' ')}`,
            stderr: '',
            durationMs: 1,
        };
    },
};

const runner = new AiRunner({ processExecutor });
```

## Doctor Checks

`DoctorRunner` verifies both installation and authentication state. Auth checks use each agent's native command when available, and known credential files or environment variables when the CLI has no auth-status command.

```ts
import { DoctorRunner } from '@gobing-ai/ts-ai-runner';

const doctor = new DoctorRunner();
const report = await doctor.runAll();

const usable = report.filter((agent) => agent.usable);
```

Each result includes:

```ts
interface DoctorResult {
    agent: string;
    installed: boolean;
    version: string | null;
    authenticated: boolean;
    usable: boolean;
    tier: 1 | 2;
    channels: string[];
    error: string | null;
}
```

Tier `1` agents support direct prompt-style CLI execution. Tier `2` agents are gateway or TUI constrained and may require adapter logic in the downstream app.

## Slash Command Translation

Claude-style plugin commands use `/plugin:command args`. Other agents expose different command syntaxes. Use `translateSlashCommand()` before sending user-entered slash commands to a target agent:

```ts
import { translateSlashCommand } from '@gobing-ai/ts-ai-runner';

translateSlashCommand('claude', '/rd3:dev-fixall bun run check');
// /rd3:dev-fixall bun run check

translateSlashCommand('codex', '/rd3:dev-fixall bun run check');
// $rd3-dev-fixall bun run check

translateSlashCommand('pi', '/rd3:dev-fixall bun run check');
// /skill:rd3-dev-fixall bun run check
```

Non-slash input is returned unchanged.

## Command Shims

If you need to inspect command construction without launching a process, use the pure shim API:

```ts
import { getAgentShim } from '@gobing-ai/ts-ai-runner';

const shim = getAgentShim('codex');
const command = shim.getPromptCommand({ input: 'Summarize this repository' });

console.log(command.command, command.args);
```

This is the right layer for UI previews, audit logging, and custom launchers.

## Team Mode Primitives

The team-mode APIs are intentionally small building blocks. They do not implement an HTTP API,
dashboard, or product workflow; downstream apps compose them into their own orchestration layer.

### Agent specs

Agent specs define agents as config. The built-in parser supports the repository's constrained YAML
subset: scalars, arrays, nested objects, and no anchors/tags/multiline scalars.

```ts
import { loadAgentSpecs, saveAgentSpec } from '@gobing-ai/ts-ai-runner';

await saveAgentSpec(
    {
        id: 'coder',
        name: 'Coder',
        type: 'codex',
        workspace: '/workspace/spur',
        purpose: 'Implement scoped code changes',
        tags: ['code'],
        config: { model: 'gpt-5', systemPrompt: 'Follow repository rules.' },
        autoStart: true,
    },
    './agents',
);

const specs = loadAgentSpecs('./agents');
```

`validateAgentId()` enforces lowercase agent ids with alphanumeric, `_`, and `-` characters.

### Durable messages

`MessageService` wraps `InboxMessageDao` from `@gobing-ai/ts-db/inbox`. It owns no subprocess
behavior; it only persists, drains, marks delivery/failure, and formats messages.

```ts
import { InboxMessageDao } from '@gobing-ai/ts-db/inbox';
import { MessageService } from '@gobing-ai/ts-ai-runner';

const messages = new MessageService(new InboxMessageDao(adapter));

const id = await messages.enqueue(null, 'coder', 'Review the runtime process seam');
const pending = await messages.drain('coder');

for (const msg of pending) {
    console.log(MessageService.formatMessage(msg));
    await messages.deliver(msg.id);
}
```

### Persistent agent processes

`TeamAgentProcess` wraps a long-running agent subprocess using the runtime pipe-process seam. It
supports start/stop, stdin sends, stdout/stderr subscriptions, status, pid, and exit-code queries.

```ts
import { TeamAgentProcess, type AgentSpec } from '@gobing-ai/ts-ai-runner';

const spec: AgentSpec = {
    id: 'coder',
    name: 'Coder',
    type: 'codex',
    workspace: '/workspace/spur',
    purpose: 'Implement scoped code changes',
    tags: [],
    config: {},
};

const process = new TeamAgentProcess({
    spec,
    command: ['codex', 'exec', 'You are coder. Wait for inbox messages.'],
});

const unsubscribe = process.subscribe((chunk) => {
    console.log(chunk.toString());
});

await process.start();
await process.send('[task from=operator id=msg-1] Inspect packages/db');
await process.stop();
unsubscribe();
```

### Team orchestrator

`TeamOrchestrator` connects specs, shims, processes, and messages. On start it loads an agent spec,
builds the agent command through the matching shim, starts the process, drains pending inbox messages,
and injects them live. `sendMessage()` always persists first, then injects immediately when the target
agent is running.

```ts
import { InboxMessageDao } from '@gobing-ai/ts-db/inbox';
import { MessageService, TeamOrchestrator } from '@gobing-ai/ts-ai-runner';

const messages = new MessageService(new InboxMessageDao(adapter));
const team = new TeamOrchestrator('./agents', messages);

await team.startAgent('coder');
await team.sendMessage(null, 'coder', 'Please implement task 0005');

console.log(team.getAgentStatus('coder')); // running

await team.stopAll();
```

## Boundary Notes

- This package is a command adapter, not an agent orchestration framework.
- It does not install agent CLIs or manage credentials.
- It does not parse agent responses beyond process result capture.
- It keeps subprocess launching behind `ProcessExecutor` / `PipeProcessSpawner`, so tests can stay deterministic.
- Team-mode persistence is delegated to `@gobing-ai/ts-db/inbox`; host apps own migrations and adapter lifecycle.
