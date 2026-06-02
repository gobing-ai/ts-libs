# @gobing-ai/ts-ai-runner

Coding-agent command shims, installation detection, doctor checks, slash-command translation, and prompt execution for downstream CLIs.

## What It Provides

`ts-ai-runner` normalizes the command-line surface of common coding agents so application code can work with stable TypeScript APIs instead of hard-coded executable arguments.

| Export | Purpose |
|--------|---------|
| `AiRunner` | Runs help, version, auth, and prompt commands through a pluggable process executor |
| `AgentDetector` | Probes supported agent CLIs and parses version output |
| `DoctorRunner` | Combines installation and authentication checks into a usability report |
| `getAgentShim()` | Returns the pure command builder for one supported agent |
| `translateSlashCommand()` | Converts Claude-style `/plugin:command` inputs to each agent's dialect |

Supported agent identifiers are `claude`, `codex`, `gemini`, `pi`, `opencode`, `antigravity`, and `openclaw`.

## Installation

```bash
bun add @gobing-ai/ts-ai-runner
```

The package depends on `@gobing-ai/ts-runtime` for process execution. The target agent CLIs are not bundled; install them separately in the host environment.

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

## Boundary Notes

- This package is a command adapter, not an agent orchestration framework.
- It does not install agent CLIs or manage credentials.
- It does not parse agent responses beyond process result capture.
- It keeps subprocess launching behind `ProcessExecutor`, so tests can stay deterministic.
