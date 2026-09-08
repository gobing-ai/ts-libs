import { describe, expect, test } from 'bun:test';
import { EventBus, type Logger } from '@gobing-ai/ts-infra';
import {
    NodeProcessExecutor,
    type PipeProcess,
    type PipeProcessOptions,
    type ProcessEventDetail,
    type ProcessExecutor,
    type ProcessSignal,
} from '@gobing-ai/ts-runtime';
import {
    type AgentEvents,
    type AgentQuotaObservation,
    type AgentSpec,
    type AiRunnerProcessEvents,
    TeamAgentProcess,
} from '../src';

const spec: AgentSpec = {
    id: 'coder',
    name: 'Coder',
    type: 'codex',
    workspace: process.cwd(),
    purpose: 'Echo messages',
    tags: [],
    config: {},
};

describe('TeamAgentProcess', () => {
    test('starts, sends stdin, publishes output, and stops', async () => {
        const process = new TeamAgentProcess({
            spec,
            command: [
                'bun',
                '-e',
                "process.stdin.on('data', (chunk) => process.stdout.write(chunk)); setInterval(() => {}, 1000);",
            ],
        });
        const output: string[] = [];
        const unsubscribe = process.subscribe((data) => output.push(data.toString()));

        await process.start();
        expect(process.getStatus()).toBe('running');
        expect(process.getPid()).toBeGreaterThan(0);

        expect(await process.send('hello')).toEqual({ ok: true });
        await waitFor(() => output.join('').includes('hello'));
        await process.stop();
        unsubscribe();

        expect(process.getStatus()).toBe('stopped');
        expect(process.getPid()).toBeNull();
        expect(process.getExitCode()).not.toBeNull();
    });

    test('send fails when process is not running', async () => {
        const warnings: Array<{ msg: string; data?: Record<string, unknown> }> = [];
        const process = new TeamAgentProcess({
            spec,
            command: ['bun', '--version'],
            logger: makeRecordingLogger(warnings),
        });

        expect(await process.send('hello')).toEqual({ ok: false });
        expect(warnings).toContainEqual({
            msg: 'send skipped because process is not running',
            data: { agentId: 'coder', op: 'send.notRunning' },
        });
    });

    test('reports natural non-zero exits as errored', async () => {
        const process = new TeamAgentProcess({
            spec,
            command: ['bun', '-e', 'process.exit(7)'],
        });
        await process.start();
        await waitFor(() => process.getExitCode() === 7);
        expect(process.getStatus()).toBe('errored');
    });

    test('uses injected executor and marks write failures errored with a warning', async () => {
        const warnings: Array<{ msg: string; data?: Record<string, unknown> }> = [];
        const fakeProcess = new FakePipeProcess({ writeThrows: true });
        const executor = new FakeExecutor(fakeProcess);
        const process = new TeamAgentProcess({
            spec,
            command: ['fake'],
            processExecutor: executor,
            logger: makeRecordingLogger(warnings),
        });

        await process.start();
        await process.start();
        expect(executor.runStreamingCount).toBe(1);
        expect(executor.calls[0]).toMatchObject({ command: 'fake', label: 'team-agent.coder' });
        expect(await process.send('hello')).toEqual({ ok: false });
        expect(process.getStatus()).toBe('errored');
        expect(warnings).toContainEqual({
            msg: 'stdin write failed',
            data: { agentId: 'coder', op: 'send.writeStdin', error: 'stdin closed' },
        });
    });

    test('stop is a no-op before start', async () => {
        const process = new TeamAgentProcess({ spec, command: ['fake'], processExecutor: new FakeExecutor() });
        await process.stop();
        expect(process.getStatus()).toBe('stopped');
    });

    test('process events are observed when routed through an instrumented executor', async () => {
        const events = new EventBus<AiRunnerProcessEvents>();
        const observed: Array<{ event: string; detail: ProcessEventDetail }> = [];
        events.on('process.started', (detail) => observed.push({ event: 'process.started', detail }));
        events.on('process.exited', (detail) => observed.push({ event: 'process.exited', detail }));
        const processExecutor = new NodeProcessExecutor({
            events: {
                emit: (event, detail) => {
                    void events.emit(event, detail);
                },
            },
        });
        const process = new TeamAgentProcess({ spec, command: ['cat'], processExecutor });

        await process.start();
        await process.stop();

        expect(observed.map((entry) => entry.event)).toEqual(['process.started', 'process.exited']);
        expect(observed[0]?.detail).toMatchObject({ command: 'cat', label: 'team-agent.coder' });
        expect(observed[1]?.detail).toMatchObject({ command: 'cat', reason: 'signal', signal: 'SIGTERM' });
    });

    test('stop escalates from SIGTERM to SIGKILL after timeout', async () => {
        const fakeProcess = new FakePipeProcess({ resolveOnSigkill: true });
        const process = new TeamAgentProcess({
            spec,
            command: ['fake'],
            processExecutor: new FakeExecutor(fakeProcess),
        });

        await process.start();
        await process.stop();

        expect(fakeProcess.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
        expect(process.getStatus()).toBe('stopped');
        expect(process.getExitCode()).toBeNull();
    }, 7000);

    test('stop logs stdin close failures before terminating', async () => {
        const warnings: Array<{ msg: string; data?: Record<string, unknown> }> = [];
        const fakeProcess = new FakePipeProcess({ endThrows: true });
        const process = new TeamAgentProcess({
            spec,
            command: ['fake'],
            processExecutor: new FakeExecutor(fakeProcess),
            logger: makeRecordingLogger(warnings),
        });

        await process.start();
        fakeProcess.resolveExit(0);
        await process.stop();

        expect(warnings).toContainEqual({
            msg: 'stdin close failed',
            data: { agentId: 'coder', op: 'stop.endStdin', error: 'stdin already closed' },
        });
    });

    test('pipe errors are logged and mark the process errored', async () => {
        const warnings: Array<{ msg: string; data?: Record<string, unknown> }> = [];
        const process = new TeamAgentProcess({
            spec,
            command: ['fake'],
            processExecutor: new FakeExecutor(new FakePipeProcess({ stdout: errorStream('stream exploded') })),
            logger: makeRecordingLogger(warnings),
        });

        await process.start();
        await waitFor(() => process.getStatus() === 'errored');

        expect(warnings).toContainEqual({
            msg: 'stream pipe failed',
            data: { agentId: 'coder', op: 'pipe', error: 'stream exploded' },
        });
    });
});

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
        if (predicate()) return;
        await Bun.sleep(20);
    }
    throw new Error('Timed out waiting for condition');
}

function makeRecordingLogger(sink: Array<{ msg: string; data?: Record<string, unknown> }>): Logger {
    const logger: Logger = {
        trace: () => undefined,
        debug: () => undefined,
        info: () => undefined,
        warn: (msg, data) => {
            sink.push({ msg, ...(data !== undefined ? { data } : {}) });
        },
        error: () => undefined,
        fatal: () => undefined,
        child: () => logger,
    };
    return logger;
}

class FakeExecutor implements ProcessExecutor {
    runStreamingCount = 0;
    readonly calls: PipeProcessOptions[] = [];

    constructor(private readonly process = new FakePipeProcess()) {}

    runStreaming(options: PipeProcessOptions): PipeProcess {
        this.runStreamingCount += 1;
        this.calls.push(options);
        return this.process;
    }

    async run(): Promise<never> {
        throw new Error('FakeExecutor.run not implemented');
    }
}

class FakePipeProcess implements PipeProcess {
    readonly pid = 123;
    readonly stdout: ReadableStream<Uint8Array> | null;
    readonly stderr = null;
    readonly exited: Promise<number | null>;
    readonly killSignals: Array<ProcessSignal | undefined> = [];
    private exitResolve!: (code: number | null) => void;

    constructor(
        private readonly options: {
            writeThrows?: boolean;
            endThrows?: boolean;
            resolveOnSigkill?: boolean;
            stdout?: ReadableStream<Uint8Array>;
        } = {},
    ) {
        this.stdout = options.stdout ?? null;
        this.exited = new Promise<number | null>((resolve) => {
            this.exitResolve = resolve;
        });
    }

    writeStdin(): void {
        if (this.options.writeThrows === true) throw new Error('stdin closed');
    }

    endStdin(): void {
        if (this.options.endThrows === true) throw new Error('stdin already closed');
    }

    kill(signal?: ProcessSignal): void {
        this.killSignals.push(signal);
        if (signal === 'SIGTERM' && this.options.resolveOnSigkill !== true) this.resolveExit(143);
        if (signal === 'SIGKILL' && this.options.resolveOnSigkill === true) this.resolveExit(null);
    }

    resolveExit(code: number | null): void {
        this.exitResolve(code);
    }
}

function errorStream(message: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        pull: (controller) => {
            controller.error(new Error(message));
        },
    });
}

describe('TeamAgentProcess — streaming quota observation (Spur 0798 R1/R2)', () => {
    test('confirmed streaming quota failure emits one attributed event; subscribers still see raw chunks', async () => {
        const events = new EventBus<AgentEvents>();
        const seen: AgentQuotaObservation[] = [];
        events.on('agent.quota.exhausted', (o) => seen.push(o));
        const raw: string[] = [];
        const process = new TeamAgentProcess({
            spec,
            events,
            quotaContext: { projectId: 'proj-1', executor: 'omp', model: 'zai/glm-5.2' },
            command: [
                'bun',
                '-e',
                "process.stderr.write(JSON.stringify({error:{type:'insufficient_quota',code:'insufficient_quota'}})); process.exit(3);",
            ],
        });
        const unsubscribe = process.subscribe((data) => raw.push(data.toString()));

        await process.start();
        await waitFor(() => process.getStatus() !== 'running');
        unsubscribe();

        expect(process.getStatus()).toBe('errored');
        expect(process.getExitCode()).toBe(3);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.evidenceSource).toBe('streaming-error');
        expect(seen[0]?.reason).toBe('insufficient_quota');
        expect(seen[0]?.attribution).toEqual({
            projectId: 'proj-1',
            executor: 'omp',
            agent: 'coder',
            model: 'zai/glm-5.2',
        });
        expect(raw.join('')).toContain('insufficient_quota');
    });

    test('rate-limited streaming failure emits no quota event', async () => {
        const events = new EventBus<AgentEvents>();
        const seen: AgentQuotaObservation[] = [];
        events.on('agent.quota.exhausted', (o) => seen.push(o));
        const process = new TeamAgentProcess({
            spec,
            events,
            command: [
                'bun',
                '-e',
                "process.stderr.write(JSON.stringify({error:{type:'rate_limit_error',code:'429'}})); process.exit(1);",
            ],
        });
        await process.start();
        await waitFor(() => process.getStatus() !== 'running');

        expect(process.getStatus()).toBe('errored');
        expect(seen).toHaveLength(0);
    });

    test('spec fallback attribution when no quotaContext is supplied', async () => {
        const events = new EventBus<AgentEvents>();
        const seen: AgentQuotaObservation[] = [];
        events.on('agent.quota.exhausted', (o) => seen.push(o));
        const process = new TeamAgentProcess({
            spec,
            events,
            command: [
                'bun',
                '-e',
                "process.stderr.write(JSON.stringify({error:{code:'credits_exhausted'}})); process.exit(2);",
            ],
        });
        await process.start();
        await waitFor(() => process.getStatus() !== 'running');

        expect(seen).toHaveLength(1);
        expect(seen[0]?.attribution).toEqual({ agent: 'coder', executor: 'codex' });
    });

    test('successful streaming runs emit no quota event', async () => {
        const events = new EventBus<AgentEvents>();
        const seen: AgentQuotaObservation[] = [];
        events.on('agent.quota.exhausted', (o) => seen.push(o));
        const process = new TeamAgentProcess({
            spec,
            events,
            command: ['bun', '-e', 'process.exit(0)'],
        });
        await process.start();
        await waitFor(() => process.getStatus() !== 'running');

        expect(process.getStatus()).toBe('stopped');
        expect(seen).toHaveLength(0);
    });
});
