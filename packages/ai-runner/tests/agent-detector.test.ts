import { describe, expect, test } from 'bun:test';
import type { ProcessExecutor, ProcessOptions, ProcessResult } from '@gobing-ai/ts-runtime';
import { AgentDetector, type DetectedAgent } from '../src/agent-detector';
import { AiRunner } from '../src/ai-runner';

class FakeExecutor implements ProcessExecutor {
    readonly calls: ProcessOptions[] = [];

    constructor(private readonly responder: (options: ProcessOptions) => Partial<ProcessResult> = () => ({})) {}

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

describe('AgentDetector', () => {
    test('detectAll returns an array with one entry per display-order agent', async () => {
        const executor = new FakeExecutor((options) => {
            const agent = options.args?.includes('--version') ? options.command : 'unknown';
            return { stdout: `${agent} 1.0.0` };
        });
        const runner = new AiRunner({ processExecutor: executor });
        const detector = new AgentDetector({ runner });
        const results: DetectedAgent[] = await detector.detectAll();

        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBeGreaterThan(0);
        for (const entry of results) {
            expect(entry).toHaveProperty('name');
            expect(entry).toHaveProperty('installed');
            expect(entry).toHaveProperty('version');
            expect(entry).toHaveProperty('error');
        }
    });

    test('detectOne returns not-installed for unknown agent name', async () => {
        const detector = new AgentDetector({
            runner: new AiRunner({ processExecutor: new FakeExecutor() }),
        });
        const result = await detector.detectOne('not-an-agent');

        expect(result).toMatchObject({
            name: 'not-an-agent',
            installed: false,
            version: null,
        });
        expect(result.error).toContain('Unknown agent');
    });

    test('detectOne parses version from valid stdout', async () => {
        const executor = new FakeExecutor(() => ({ stdout: 'pi 2.3.4' }));
        const detector = new AgentDetector({
            runner: new AiRunner({ processExecutor: executor }),
        });
        const result = await detector.detectOne('pi');

        expect(result).toMatchObject({
            name: 'pi',
            installed: true,
            version: '2.3.4',
        });
    });

    test('detectOne extracts only the semantic version, not the whole line', async () => {
        const executor = new FakeExecutor(() => ({ stdout: 'opencode version 1.4.0 (build 9c2f)' }));
        const detector = new AgentDetector({
            runner: new AiRunner({ processExecutor: executor }),
        });
        const result = await detector.detectOne('opencode');

        expect(result.installed).toBe(true);
        expect(result.version).toBe('1.4.0');
    });
});
