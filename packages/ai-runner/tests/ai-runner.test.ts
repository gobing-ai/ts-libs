import { describe, expect, test } from 'bun:test';
import type { Logger } from '@gobing-ai/ts-infra';
import { ProcessExecutor, type ProcessOptions, type ProcessResult } from '@gobing-ai/ts-runtime';
import { AgentDetector, AiRunner, DISPLAY_ORDER, DoctorRunner, getAgentShim } from '../src';

/** A Logger that records (level, msg) for assertions. */
function makeRecordingLogger(sink: Array<{ level: string; msg: string }>): Logger {
    const record = (level: string) => (msg: string) => {
        sink.push({ level, msg });
    };
    const logger: Logger = {
        trace: record('trace'),
        debug: record('debug'),
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
        fatal: record('fatal'),
        child: () => logger,
    };
    return logger;
}

class FakeExecutor extends ProcessExecutor {
    readonly calls: ProcessOptions[] = [];

    constructor(private readonly responder: (options: ProcessOptions) => Partial<ProcessResult>) {
        super();
    }

    override async run(options: ProcessOptions): Promise<ProcessResult> {
        this.calls.push(options);
        const response = this.responder(options);
        return {
            command: options.command,
            args: options.args ?? [],
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 1,
            ...response,
        };
    }
}

describe('AiRunner', () => {
    test('builds vendor-specific prompt commands through shims', async () => {
        const executor = new FakeExecutor(() => ({ stdout: 'ok' }));
        const runner = new AiRunner({ processExecutor: executor });
        await runner.runPromptCommand('codex', { input: 'ship it', model: 'gpt-5', mode: 'json' });
        expect(executor.calls[0]).toMatchObject({
            command: 'codex',
            args: ['exec', 'ship it', '-m', 'gpt-5', '--json'],
        });
    });

    test('prepends identity preamble only when team options are present', async () => {
        const executor = new FakeExecutor(() => ({ stdout: 'ok' }));
        const runner = new AiRunner({ processExecutor: executor, defaultCwd: '/repo' });
        await runner.runPromptCommand('codex', {
            input: 'ship it',
            purpose: 'Implement',
            systemPrompt: 'Use repo rules.',
            taskId: '0005',
            peers: [{ id: 'planner', type: 'claude', purpose: 'Plan' }],
        });

        const prompt = executor.calls[0]?.args?.[1] ?? '';
        expect(prompt).toContain('You are agent `codex` (codex) in workspace `/repo`.');
        expect(prompt).toContain('Your current task: #0005.');
        expect(prompt).toContain('Use repo rules.');
        expect(prompt).toContain('- `planner` (claude) — Plan');
        expect(prompt.endsWith('ship it')).toBeTrue();
    });

    test('runSlashCommand translates Claude-style slash commands before dispatch', async () => {
        const executor = new FakeExecutor(() => ({ stdout: 'ok' }));
        const runner = new AiRunner({ processExecutor: executor });
        await runner.runSlashCommand('codex', '/plugin:cmd args', { model: 'gpt-5' });

        expect(executor.calls[0]).toMatchObject({
            command: 'codex',
            args: ['exec', '$plugin-cmd args', '-m', 'gpt-5'],
        });
    });

    test('buildPromptCommand returns a shim command without invoking the executor', () => {
        const executor = new FakeExecutor(() => ({ stdout: 'ok' }));
        const runner = new AiRunner({ processExecutor: executor });
        const command = runner.buildPromptCommand('pi', { input: 'ship it', mode: 'json' });

        expect(command).toEqual({ command: 'pi', args: ['--no-session', '-p', 'ship it', '--mode', 'json'] });
        expect(executor.calls).toHaveLength(0);
    });

    test('logs invocation diagnostics and escalates a non-zero exit to error', async () => {
        // Non-zero exits must surface in logs; a silent failure leaves operators blind
        // to why an agent command failed (parity finding F7 — restored observability).
        const calls: Array<{ level: string; msg: string }> = [];
        const recorder = makeRecordingLogger(calls);
        const failing = new FakeExecutor(() => ({ exitCode: 1, stderr: 'boom' }));
        await new AiRunner({ processExecutor: failing, logger: recorder }).runVersionCommand('pi');

        expect(calls).toContainEqual({ level: 'debug', msg: 'invoke' });
        expect(calls.find((entry) => entry.level === 'error')?.msg).toBe('invoke exited non-zero');
    });

    test('exposes stable shim metadata', () => {
        expect(getAgentShim('pi').tier).toBe(1);
        expect(getAgentShim('openclaw').command).toBe('openclaw');
    });

    test('builds every shim command variant', () => {
        for (const agent of DISPLAY_ORDER) {
            const shim = getAgentShim(agent);
            expect(shim.getHelpCommand().command).toBe(shim.command);
            expect(shim.getVersionCommand().command).toBe(shim.command);
            expect(
                shim.getPromptCommand({ input: 'x', continue: agent !== 'codex', model: 'm', mode: 'json' }).args
                    .length,
            ).toBeGreaterThan(0);
        }
        expect(() => getAgentShim('codex').getPromptCommand({ input: 'x', continue: true })).toThrow(
            'Codex resume mode does not accept a new prompt',
        );
    });

    test('runs help and auth commands through the executor', async () => {
        const executor = new FakeExecutor(() => ({ stdout: 'ok' }));
        const runner = new AiRunner({ processExecutor: executor, defaultCwd: '/tmp', defaultTimeout: 100 });
        await runner.runHelpCommand('claude');
        await runner.runAuthCommand('claude');
        expect(executor.calls.map((call) => call.label)).toEqual(['ai-runner.claude.help', 'ai-runner.claude.auth']);
    });
});

describe('AgentDetector', () => {
    test('captures unavailable agents without throwing', async () => {
        const runner = new AiRunner({
            processExecutor: new FakeExecutor(() => ({ exitCode: 127, stderr: 'command not found' })),
        });
        const detected = await new AgentDetector({ runner }).detectOne('pi');
        expect(detected).toMatchObject({ name: 'pi', installed: false });
        expect(detected.error).toContain('command not found');
    });

    test('parses version output', async () => {
        const runner = new AiRunner({
            processExecutor: new FakeExecutor(() => ({ stdout: 'pi 1.2.3' })),
        });
        const detected = await new AgentDetector({ runner }).detectOne('pi');
        expect(detected).toMatchObject({ installed: true, version: 'pi 1.2.3' });
    });

    test('reports unknown and unparsable agents', async () => {
        const detector = new AgentDetector({
            runner: new AiRunner({ processExecutor: new FakeExecutor(() => ({ stdout: 'version unknown' })) }),
        });
        expect(await detector.detectOne('missing')).toMatchObject({
            installed: false,
            error: 'Unknown agent: missing',
        });
        expect(await detector.detectOne('pi')).toMatchObject({
            installed: false,
            error: 'Could not parse version output',
        });
    });
});

describe('DoctorRunner', () => {
    test('marks env-authenticated pi as usable', async () => {
        const runner = new AiRunner({
            processExecutor: new FakeExecutor((options) =>
                options.args?.includes('--version') === true ? { stdout: 'pi 1.2.3' } : { stdout: 'models' },
            ),
        });
        const doctor = new DoctorRunner({
            runner,
            agentDetector: new AgentDetector({ runner }),
            env: { GOOGLE_API_KEY: 'x' },
        });
        const result = await doctor.runOne('pi');
        expect(result).toMatchObject({ agent: 'pi', installed: true, authenticated: true, usable: true });
    });

    test('does not treat a blank provider key as pi authentication', async () => {
        const runner = new AiRunner({
            processExecutor: new FakeExecutor((options) =>
                options.args?.includes('--version') === true
                    ? { stdout: 'pi 1.2.3' }
                    : // pi auth fallback (--list-models) reports unauthenticated
                      { stdout: 'not authenticated' },
            ),
        });
        const doctor = new DoctorRunner({
            runner,
            agentDetector: new AgentDetector({ runner }),
            env: { GOOGLE_API_KEY: '   ' },
        });
        const result = await doctor.runOne('pi');
        expect(result.authenticated).toBe(false);
        expect(result.usable).toBe(false);
    });

    test('runs all doctor checks and handles unsupported auth commands', async () => {
        const runner = new AiRunner({
            processExecutor: new FakeExecutor((options) =>
                options.args?.includes('--version') === true
                    ? { stdout: `${options.command} 1.2.3` }
                    : { stdout: 'ok' },
            ),
        });
        const doctor = new DoctorRunner({ runner, agentDetector: new AgentDetector({ runner }), env: {} });
        const results = await doctor.runAll();
        expect(results).toHaveLength(DISPLAY_ORDER.length);
        expect(results.find((result) => result.agent === 'antigravity')).toMatchObject({
            tier: 2,
            authenticated: false,
        });
    });
});
