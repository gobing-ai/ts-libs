import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import {
    createNodeFileSystem,
    joinPath,
    ProcessExecutor,
    type ProcessOptions,
    type ProcessResult,
} from '@gobing-ai/ts-runtime';
import { AgentDetector } from '../src/agent-detector';
import { DISPLAY_ORDER } from '../src/agents/shims';
import { AiRunner } from '../src/ai-runner';
import { type DoctorResult, DoctorRunner } from '../src/doctor-runner';

class FakeExecutor extends ProcessExecutor {
    readonly calls: ProcessOptions[] = [];

    constructor(private readonly responder: (options: ProcessOptions) => Partial<ProcessResult> = () => ({})) {
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

function createVersionExecutor(): FakeExecutor {
    return new FakeExecutor((options) => {
        if (options.args?.includes('--version')) {
            return { stdout: `${options.command} 1.0.0` };
        }
        if (options.command === 'pi' && options.args?.includes('--list-models')) {
            return { stdout: 'models listed' };
        }
        return { stdout: 'ok' };
    });
}

async function createTempHome(name: string): Promise<string> {
    const home = joinPath(tmpdir(), `ts-libs-ai-runner-${Date.now()}-${name}`);
    await createNodeFileSystem().ensureDir(home);
    return home;
}

describe('DoctorRunner', () => {
    test('runAll returns an array with one result per display-order agent', async () => {
        const executor = createVersionExecutor();
        const runner = new AiRunner({ processExecutor: executor });
        const doctor = new DoctorRunner({
            runner,
            agentDetector: new AgentDetector({ runner }),
            env: {},
        });
        const results: DoctorResult[] = await doctor.runAll();

        expect(Array.isArray(results)).toBe(true);
        expect(results).toHaveLength(DISPLAY_ORDER.length);

        const names = results.map((r) => r.agent);
        expect(names).toEqual([...DISPLAY_ORDER]);

        for (const entry of results) {
            expect(entry).toHaveProperty('agent');
            expect(entry).toHaveProperty('installed');
            expect(entry).toHaveProperty('version');
            expect(entry).toHaveProperty('authenticated');
            expect(entry).toHaveProperty('usable');
            expect(entry).toHaveProperty('tier');
            expect(entry).toHaveProperty('error');
        }
    });

    test('runOne returns a single result with correct agent name', async () => {
        const executor = createVersionExecutor();
        const runner = new AiRunner({ processExecutor: executor });
        const doctor = new DoctorRunner({
            runner,
            agentDetector: new AgentDetector({ runner }),
            env: {},
        });
        const result = await doctor.runOne('pi');

        expect(result.agent).toBe('pi');
        expect(result.installed).toBe(true);
        expect(result.tier).toBe(1);
    });

    test('antigravity alias resolves to tier-1 antigravity-cli', async () => {
        const executor = createVersionExecutor();
        const runner = new AiRunner({ processExecutor: executor });
        const doctor = new DoctorRunner({
            runner,
            agentDetector: new AgentDetector({ runner }),
            env: {},
        });
        const result = await doctor.runOne('antigravity');
        // Alias resolves to canonical antigravity-cli (tier 1 since the 2.0 CLI split).
        // The alias is not "deprecated" (no deprecated marker) — it resolves cleanly.
        expect(result.agent).toBe('antigravity-cli');
        expect(result.tier).toBe(1);
        expect(result.deprecated).toBeUndefined();
    });

    test('reports claude unauthenticated when exit-0 output says loggedIn false', async () => {
        const executor = new FakeExecutor((options) =>
            options.args?.includes('--version') === true
                ? { stdout: 'claude 1.0.0' }
                : { stdout: '{"loggedIn": false}' },
        );
        const runner = new AiRunner({ processExecutor: executor });
        const doctor = new DoctorRunner({ runner, agentDetector: new AgentDetector({ runner }), env: {} });

        const result = await doctor.runOne('claude');

        expect(result.authenticated).toBe('unauthenticated');
        // Liveness-only usable: a logged-out agent is still runnable (fails at
        // runtime with its own error). Auth no longer gates runnability.
        expect(result.usable).toBe(true);
    });

    test('usable is liveness-only — auth no longer gates runnability', async () => {
        // claude installed + version, but auth probe reports logged-out.
        const executor = new FakeExecutor((options) =>
            options.args?.includes('--version') === true
                ? { stdout: 'claude 1.0.0' }
                : { stdout: '{"loggedIn": false}' },
        );
        const runner = new AiRunner({ processExecutor: executor });
        const doctor = new DoctorRunner({ runner, agentDetector: new AgentDetector({ runner }), env: {} });

        const result = await doctor.runOne('claude');

        expect(result.installed).toBe(true);
        expect(result.version).not.toBeNull();
        expect(result.authenticated).toBe('unauthenticated');
        expect(result.usable).toBe(true);
    });

    test('agent with no auth verb reports authenticated unknown but is still usable', async () => {
        // antigravity-cli's shim returns getAuthCommand() => null — no probe,
        // so auth state is genuinely unknown, not unauthenticated.
        const executor = new FakeExecutor((options) =>
            options.args?.includes('--version') === true ? { stdout: 'agy 1.0.0' } : { stdout: 'unused' },
        );
        const runner = new AiRunner({ processExecutor: executor });
        const doctor = new DoctorRunner({ runner, agentDetector: new AgentDetector({ runner }), env: {} });

        const result = await doctor.runOne('antigravity-cli');

        expect(result.authenticated).toBe('unknown');
        expect(result.usable).toBe(true);
    });

    test('an uninstalled agent is not usable regardless of auth', async () => {
        const executor = new FakeExecutor(() => ({ stdout: '', exitCode: 127 }));
        const runner = new AiRunner({ processExecutor: executor });
        const doctor = new DoctorRunner({ runner, agentDetector: new AgentDetector({ runner }), env: {} });

        const result = await doctor.runOne('claude');

        expect(result.installed).toBe(false);
        expect(result.version).toBeNull();
        expect(result.usable).toBe(false);
    });

    test('reports openclaw unauthenticated when health output is unhealthy', async () => {
        const executor = new FakeExecutor((options) =>
            options.args?.includes('--version') === true ? { stdout: 'openclaw 1.0.0' } : { stdout: 'unhealthy' },
        );
        const runner = new AiRunner({ processExecutor: executor });
        const doctor = new DoctorRunner({ runner, agentDetector: new AgentDetector({ runner }), env: {} });

        const result = await doctor.runOne('openclaw');

        expect(result.authenticated).toBe('unauthenticated');
    });

    test('reports claude authenticated only with a positive auth signal', async () => {
        const executor = new FakeExecutor((options) =>
            options.args?.includes('--version') === true
                ? { stdout: 'claude 1.0.0' }
                : { stdout: '{"loggedIn": true}' },
        );
        const runner = new AiRunner({ processExecutor: executor });
        const doctor = new DoctorRunner({ runner, agentDetector: new AgentDetector({ runner }), env: {} });

        const result = await doctor.runOne('claude');

        expect(result.authenticated).toBe('authenticated');
    });

    test('treats inconclusive exit-0 auth output as unknown (not unauthenticated)', async () => {
        const executor = new FakeExecutor((options) =>
            options.args?.includes('--version') === true
                ? { stdout: 'claude 1.0.0' }
                : { stdout: 'usage: claude auth' },
        );
        const runner = new AiRunner({ processExecutor: executor });
        const doctor = new DoctorRunner({ runner, agentDetector: new AgentDetector({ runner }), env: {} });

        const result = await doctor.runOne('claude');

        expect(result.authenticated).toBe('unknown');
    });

    test('trusts codex CLI unauthenticated output over a stale auth.json file', async () => {
        const home = await createTempHome('codex-stale');
        const fs = createNodeFileSystem();
        await fs.ensureDir(joinPath(home, '.codex'));
        await fs.writeFile(joinPath(home, '.codex', 'auth.json'), '{"token":"stale"}');
        const executor = new FakeExecutor((options) =>
            options.args?.includes('--version') === true ? { stdout: 'codex 1.0.0' } : { stdout: 'Not logged in' },
        );
        const runner = new AiRunner({ processExecutor: executor });
        const doctor = new DoctorRunner({ runner, agentDetector: new AgentDetector({ runner }), env: { HOME: home } });

        const result = await doctor.runOne('codex');

        expect(result.authenticated).toBe('unauthenticated');
    });

    test('falls back to extensionless codex auth file when CLI output is inconclusive', async () => {
        const home = await createTempHome('codex-auth');
        const fs = createNodeFileSystem();
        await fs.ensureDir(joinPath(home, '.codex'));
        await fs.writeFile(joinPath(home, '.codex', 'auth'), '{"token":"live"}');
        const executor = new FakeExecutor((options) =>
            options.args?.includes('--version') === true ? { stdout: 'codex 1.0.0' } : { stdout: 'codex login status' },
        );
        const runner = new AiRunner({ processExecutor: executor });
        const doctor = new DoctorRunner({ runner, agentDetector: new AgentDetector({ runner }), env: { HOME: home } });

        const result = await doctor.runOne('codex');

        expect(result.authenticated).toBe('authenticated');
    });

    test('requires gemini settings to contain credential-like content', async () => {
        const fs = createNodeFileSystem();
        const prefsOnlyHome = await createTempHome('gemini-prefs');
        await fs.ensureDir(joinPath(prefsOnlyHome, '.gemini'));
        await fs.writeFile(joinPath(prefsOnlyHome, '.gemini', 'settings.json'), '{"theme":"dark"}');
        const tokenHome = await createTempHome('gemini-token');
        await fs.ensureDir(joinPath(tokenHome, '.gemini'));
        await fs.writeFile(joinPath(tokenHome, '.gemini', 'settings.json'), '{"token":"live"}');
        const executor = new FakeExecutor(() => ({ stdout: 'gemini 1.0.0' }));
        const runner = new AiRunner({ processExecutor: executor });

        const prefsOnly = await new DoctorRunner({
            runner,
            agentDetector: new AgentDetector({ runner }),
            env: { HOME: prefsOnlyHome },
        }).runOne('gemini');
        const withToken = await new DoctorRunner({
            runner,
            agentDetector: new AgentDetector({ runner }),
            env: { HOME: tokenHome },
        }).runOne('gemini');

        expect(prefsOnly.authenticated).toBe('unauthenticated');
        expect(withToken.authenticated).toBe('authenticated');
    });

    test('runAll synthesizes missing display-order agents as unavailable', async () => {
        const detector = {
            detectAll: async () => [
                { name: 'claude', installed: true, version: 'claude 1.0.0', channels: [], error: null },
            ],
            detectOne: async () => ({
                name: 'claude',
                installed: true,
                version: 'claude 1.0.0',
                channels: [],
                error: null,
            }),
        } as unknown as AgentDetector;
        const runner = new AiRunner({ processExecutor: new FakeExecutor(() => ({ stdout: '{"loggedIn": true}' })) });
        const results = await new DoctorRunner({ runner, agentDetector: detector, env: {} }).runAll();

        expect(results).toHaveLength(DISPLAY_ORDER.length);
        expect(results.find((result) => result.agent === 'codex')).toMatchObject({
            installed: false,
            error: 'Unknown agent: codex',
        });
    });
});
