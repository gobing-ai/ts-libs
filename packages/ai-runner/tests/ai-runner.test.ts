import { describe, expect, test } from 'bun:test';
import type { ProcessExecutor, ProcessOptions, ProcessResult } from '@gobing-ai/ts-runtime';
import { AgentDetector, AiRunner, DISPLAY_ORDER, DoctorRunner, getAgentShim } from '../src';

class FakeExecutor implements ProcessExecutor {
    readonly calls: ProcessOptions[] = [];
    constructor(private readonly responder: (options: ProcessOptions) => Partial<ProcessResult>) {}

    async run(options: ProcessOptions): Promise<ProcessResult> {
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
        expect(detected).toMatchObject({ installed: true, version: '1.2.3' });
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
