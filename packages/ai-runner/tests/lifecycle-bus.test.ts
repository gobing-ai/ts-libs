import { describe, expect, test } from 'bun:test';
import type { BusLifecycleEvents } from '@gobing-ai/ts-infra';
import { EventBus, setLoggerMuted } from '@gobing-ai/ts-infra';
import type { ProcessExecutor, ProcessOptions, ProcessResult } from '@gobing-ai/ts-runtime';
import { AiRunner } from '../src';
import type { AgentEvents, AiRunnerProcessEvents } from '../src/events';
import type { AgentQuotaObservation } from '../src/quota';

setLoggerMuted(true);

class FakeExecutor implements ProcessExecutor {
    readonly calls: ProcessOptions[] = [];

    async run(options: ProcessOptions): Promise<ProcessResult> {
        this.calls.push(options);
        options.onSpawn?.(12345);
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

/** Executor that fails with a fixed stderr — quota classification fixtures. */
class FailingExecutor implements ProcessExecutor {
    readonly calls: ProcessOptions[] = [];

    constructor(private readonly stderr: string) {}

    async run(options: ProcessOptions): Promise<ProcessResult> {
        this.calls.push(options);
        return {
            command: options.command,
            args: options.args ?? [],
            exitCode: 1,
            stdout: '',
            stderr: this.stderr,
            durationMs: 2,
        };
    }

    runStreaming(): never {
        throw new Error('FakeExecutor.runStreaming not implemented');
    }
}

describe('AiRunner — buffered quota observation (Spur 0798 R1/R2)', () => {
    const QUOTA_STDERR = JSON.stringify({ error: { type: 'insufficient_quota', code: 'insufficient_quota' } });
    const RATE_STDERR = JSON.stringify({ error: { type: 'rate_limit_error', code: '429' } });

    test('confirmed quota failure emits one attributed event and preserves the original result', async () => {
        const events = new EventBus<AgentEvents>();
        const seen: AgentQuotaObservation[] = [];
        events.on('agent.quota.exhausted', (o) => seen.push(o));
        const runner = new AiRunner({ processExecutor: new FailingExecutor(QUOTA_STDERR), events });

        const result = await runner.runHelpCommand('codex', {
            quotaContext: { projectId: 'p-1', executor: 'codex' },
            correlation: { runId: 'r-1', executionId: 'e-1' },
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('insufficient_quota');
        expect(seen).toHaveLength(1);
        expect(seen[0]?.evidenceSource).toBe('buffered-error');
        expect(seen[0]?.reason).toBe('insufficient_quota');
        expect(seen[0]?.attribution).toEqual({ projectId: 'p-1', executor: 'codex', agent: 'codex' });
        expect(seen[0]?.correlation).toEqual({ runId: 'r-1', executionId: 'e-1' });
    });

    test('redelivery of the same quota fact is suppressed to one event', async () => {
        const events = new EventBus<AgentEvents>();
        const seen: AgentQuotaObservation[] = [];
        events.on('agent.quota.exhausted', (o) => seen.push(o));
        const runner = new AiRunner({ processExecutor: new FailingExecutor(QUOTA_STDERR), events });

        await runner.runHelpCommand('codex');
        await runner.runHelpCommand('codex');
        expect(seen).toHaveLength(1);
    });

    test('generic 429 throttling emits no quota event and the failure result stays intact', async () => {
        const events = new EventBus<AgentEvents>();
        const seen: AgentQuotaObservation[] = [];
        events.on('agent.quota.exhausted', (o) => seen.push(o));
        const runner = new AiRunner({ processExecutor: new FailingExecutor(RATE_STDERR), events });

        const result = await runner.runHelpCommand('codex', { quotaContext: { projectId: 'p-1' } });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('rate_limit_error');
        expect(seen).toHaveLength(0);
    });

    test('missing quotaContext stays observable without inferred attribution', async () => {
        const events = new EventBus<AgentEvents>();
        const seen: AgentQuotaObservation[] = [];
        events.on('agent.quota.exhausted', (o) => seen.push(o));
        const runner = new AiRunner({ processExecutor: new FailingExecutor(QUOTA_STDERR), events });

        await runner.runHelpCommand('gemini');
        expect(seen).toHaveLength(1);
        expect(seen[0]?.attribution).toEqual({ agent: 'gemini' });
    });

    test('successful invocations never classify', async () => {
        const events = new EventBus<AgentEvents>();
        const seen: AgentQuotaObservation[] = [];
        events.on('agent.quota.exhausted', (o) => seen.push(o));
        const runner = new AiRunner({ processExecutor: new FakeExecutor(), events });

        await runner.runHelpCommand('codex');
        expect(seen).toHaveLength(0);
    });
});
