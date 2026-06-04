import { describe, expect, test } from 'bun:test';
import { ProcessExecutor, type ProcessOptions, type ProcessResult } from '@gobing-ai/ts-runtime';
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

    test('tier-2 agents are marked with tier 2', async () => {
        const executor = createVersionExecutor();
        const runner = new AiRunner({ processExecutor: executor });
        const doctor = new DoctorRunner({
            runner,
            agentDetector: new AgentDetector({ runner }),
            env: {},
        });
        const result = await doctor.runOne('antigravity');

        expect(result.agent).toBe('antigravity');
        expect(result.tier).toBe(2);
    });
});
