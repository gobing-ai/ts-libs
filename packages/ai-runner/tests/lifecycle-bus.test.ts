import { describe, expect, test } from 'bun:test';
import type { BusLifecycleEvents } from '@gobing-ai/ts-infra';
import { EventBus, setLoggerMuted } from '@gobing-ai/ts-infra';
import type { ProcessExecutor, ProcessOptions, ProcessResult } from '@gobing-ai/ts-runtime';
import { AiRunner } from '../src';
import type { AgentEvents, AiRunnerProcessEvents } from '../src/events';

setLoggerMuted(true);

class FakeExecutor implements ProcessExecutor {
    readonly calls: ProcessOptions[] = [];

    async run(options: ProcessOptions): Promise<ProcessResult> {
        this.calls.push(options);
        return {
            command: options.command,
            args: options.args ?? [],
            exitCode: 0,
            stdout: 'ok',
            stderr: '',
            durationMs: 1,
        };
    }

    runStreaming(): never {
        throw new Error('FakeExecutor.runStreaming not implemented');
    }
}

/**
 * R4: AiRunner accepts an optional lifecycleBus. When `events` / `processEvents`
 * are omitted the runner constructs internal buses parented to it so `agent.*`
 * and `process.*` emits bridge into the System Events stream.
 */
describe('AiRunner — lifecycle bus propagation (R4)', () => {
    test('agent.invoke.start / agent.invoke.exit reach the parent lifecycle bus', async () => {
        const seen: string[] = [];
        const lifecycleBus = new EventBus<BusLifecycleEvents>();
        lifecycleBus.on('bus.emit.done', (d) => seen.push(d.event));

        const executor = new FakeExecutor();
        const runner = new AiRunner({ processExecutor: executor, lifecycleBus });

        await runner.runHelpCommand('codex');

        expect(seen).toContain('agent.invoke.start');
        expect(seen).toContain('agent.invoke.exit');
    });

    test('an invocation emits agent and process breadcrumbs through the default executor', async () => {
        const seen: string[] = [];
        const lifecycleBus = new EventBus<BusLifecycleEvents>();
        lifecycleBus.on('bus.emit.done', (d) => seen.push(d.event));
        const events = new EventBus<AgentEvents>({ lifecycleBus });
        const processEvents = new EventBus<AiRunnerProcessEvents>({ lifecycleBus });

        const runner = new AiRunner({ events, processEvents, lifecycleBus });
        const invoke = (
            runner as unknown as {
                invoke: (
                    agent: 'codex',
                    operation: string,
                    command: { command: string; args: string[] },
                    options: Record<never, never>,
                    forceBuffered: boolean,
                ) => Promise<unknown>;
            }
        ).invoke.bind(runner);

        await invoke('codex', 'lifecycle-test', { command: 'echo', args: ['ok'] }, {}, true);

        expect(seen).toContain('agent.invoke.start');
        expect(seen).toContain('agent.invoke.exit');
        expect(seen).toContain('process.started');
        expect(seen).toContain('process.exited');
    });

    test('explicit events bus is used as-is — no parent propagation', async () => {
        const seen: string[] = [];
        const ownBus = new EventBus<AgentEvents>();
        ownBus.on('agent.invoke.start', (d) => seen.push(d.agent));

        const executor = new FakeExecutor();
        const runner = new AiRunner({ processExecutor: executor, events: ownBus });

        await runner.runHelpCommand('claude');
        expect(seen).toContain('claude');
    });
});
