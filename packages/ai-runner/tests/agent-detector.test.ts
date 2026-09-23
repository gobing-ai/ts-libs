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

    runStreaming(): never {
        throw new Error('FakeExecutor.runStreaming not implemented');
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
            version: 'pi 2.3.4',
        });
    });

    test('detectOne returns full first version line for display', async () => {
        const executor = new FakeExecutor(() => ({ stdout: 'opencode version 1.4.0 (build 9c2f)' }));
        const detector = new AgentDetector({
            runner: new AiRunner({ processExecutor: executor }),
        });
        const result = await detector.detectOne('opencode');

        expect(result.installed).toBe(true);
        expect(result.version).toBe('opencode version 1.4.0 (build 9c2f)');
    });

    test('detectOne preserves the intentional 2-part version parse', async () => {
        const executor = new FakeExecutor(() => ({ stdout: 'pi 1.2' }));
        const detector = new AgentDetector({
            runner: new AiRunner({ processExecutor: executor }),
        });
        const result = await detector.detectOne('pi');

        expect(result).toMatchObject({ installed: true, version: 'pi 1.2' });
    });

    test('detectOne parses grok version output with build metadata', async () => {
        // Real grok --version shape: "grok 0.2.93 (f00f96316d4b) [stable]"
        const executor = new FakeExecutor(() => ({ stdout: 'grok 0.2.93 (deadbeef) [stable]' }));
        const detector = new AgentDetector({
            runner: new AiRunner({ processExecutor: executor }),
        });
        const result = await detector.detectOne('grok');

        expect(result).toMatchObject({
            name: 'grok',
            installed: true,
        });
        expect(result.version).toContain('0.2.93');
        expect(result.error).toBeNull();
    });

    test('detectOne parses deepseek dsh --version output (task 0066)', async () => {
        // Real dsh --version shape at 0.1.5-rc.1: plain semver, no prefix.
        const executor = new FakeExecutor(() => ({ stdout: '0.1.5-rc.1' }));
        const detector = new AgentDetector({
            runner: new AiRunner({ processExecutor: executor }),
        });
        const result = await detector.detectOne('deepseek');

        expect(result).toMatchObject({ name: 'deepseek', installed: true, error: null });
        expect(result.version).toContain('0.1.5-rc.1');
    });

    test('detectOne reports the first `what` line verbatim for fm (task 0083)', async () => {
        // Real `what -q /usr/bin/fm` shape on macOS 27: one PROGRAM/PROJECT line
        // per binary slice (three identical lines observed). No fm --version flag exists.
        const line = 'PROGRAM:fm  PROJECT:FoundationModels-2.0.68.1.402';
        const executor = new FakeExecutor(() => ({ stdout: `${line}\n${line}\n${line}\n` }));
        const detector = new AgentDetector({
            runner: new AiRunner({ processExecutor: executor }),
        });
        const result = await detector.detectOne('fm');

        expect(result).toMatchObject({ name: 'fm', installed: true, error: null });
        expect(result.version).toBe(line);
    });

    test('detectOne reports fm not installed when `what` exits 1 (no /usr/bin/fm)', async () => {
        // Linux / older macOS: `what` exits 1 on the missing file, so detection
        // degrades through the existing non-zero-exit branch.
        const executor = new FakeExecutor(() => ({ exitCode: 1 }));
        const detector = new AgentDetector({
            runner: new AiRunner({ processExecutor: executor }),
        });
        const result = await detector.detectOne('fm');

        expect(result.installed).toBe(false);
        expect(result.version).toBeNull();
        expect(result.error).toContain('Non-zero exit code: 1');
    });

    test('detectOne reports distinct signal and null-exit errors', async () => {
        const signalDetector = new AgentDetector({
            runner: new AiRunner({ processExecutor: new FakeExecutor(() => ({ exitCode: null, signal: 'SIGTERM' })) }),
        });
        const nullExitDetector = new AgentDetector({
            runner: new AiRunner({ processExecutor: new FakeExecutor(() => ({ exitCode: null })) }),
        });

        expect(await signalDetector.detectOne('pi')).toMatchObject({
            installed: false,
            error: 'Terminated by signal: SIGTERM',
        });
        expect(await nullExitDetector.detectOne('pi')).toMatchObject({
            installed: false,
            error: 'Process did not produce an exit code',
        });
    });
});

describe('AgentDetector deprecation surfacing (R6)', () => {
    test('gemini detection reports deprecated + replacedBy', async () => {
        const executor = new FakeExecutor(() => ({ stdout: 'gemini 1.0.0' }));
        const runner = new AiRunner({ processExecutor: executor });
        const detector = new AgentDetector({ runner });
        const result = await detector.detectOne('gemini');
        expect(result.deprecated).toBe(true);
        expect(result.replacedBy).toBe('antigravity-cli');
    });

    test('non-deprecated agents report no deprecation fields', async () => {
        const executor = new FakeExecutor(() => ({ stdout: 'claude 1.0.0' }));
        const runner = new AiRunner({ processExecutor: executor });
        const detector = new AgentDetector({ runner });
        const result = await detector.detectOne('claude');
        expect(result.deprecated).toBeUndefined();
        expect(result.replacedBy).toBeUndefined();
    });
});
