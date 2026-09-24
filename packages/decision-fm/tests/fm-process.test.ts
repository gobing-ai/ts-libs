import { describe, expect, it } from 'bun:test';
import {
    DecisionBackendError,
    DecisionConfigError,
    DecisionRequestError,
    DecisionTimeoutError,
} from '@gobing-ai/ts-ai-runner';
import type { ProcessExecutor, ProcessOptions, ProcessResult } from '@gobing-ai/ts-runtime';
import {
    availableArgv,
    countPromptTokens,
    countTokensArgv,
    parseFmRespond,
    probeFmAvailability,
    requireEnumValue,
    respondArgv,
    runFmRespond,
} from '../src/fm-process';

/** Scripted {@link ProcessExecutor} double — structural, no concrete subclassing. */
class StubFmExecutor implements ProcessExecutor {
    readonly calls: ProcessOptions[] = [];

    constructor(
        private readonly respond: ((options: ProcessOptions) => Partial<ProcessResult>) | Partial<ProcessResult> = {
            exitCode: 0,
            stdout: '{}',
        },
    ) {}

    run(options: ProcessOptions): Promise<ProcessResult> {
        this.calls.push(options);
        const scripted = typeof this.respond === 'function' ? this.respond(options) : this.respond;
        return Promise.resolve({
            command: options.command,
            args: options.args ?? [],
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 1,
            outcome: 'exit',
            ...scripted,
        });
    }

    runStreaming(): never {
        throw new Error('fm-process uses only buffered run()');
    }
}

const INSTRUCTIONS = 'answer everything';
const PROMPT = 'state text';

describe('fm argv builders (task 0084 R4, R5; 0086 R4)', () => {
    it('count-tokens: -q, --instructions=<instructions>, -- separator, prompt positional last', () => {
        expect(countTokensArgv(INSTRUCTIONS, PROMPT)).toEqual([
            'count-tokens',
            '-q',
            `--instructions=${INSTRUCTIONS}`,
            '--',
            PROMPT,
        ]);
    });

    it('respond: --no-stream --schema, --instructions=<instructions>, -- separator, prompt positional last', () => {
        expect(respondArgv({ schemaPath: '/tmp/s.json', instructions: INSTRUCTIONS, prompt: PROMPT })).toEqual([
            'respond',
            '--no-stream',
            '--schema',
            '/tmp/s.json',
            `--instructions=${INSTRUCTIONS}`,
            '--',
            PROMPT,
        ]);
    });

    it('respond adds -g in deterministic mode and --guardrails only when set', () => {
        const greedy = respondArgv({
            schemaPath: '/tmp/s.json',
            instructions: INSTRUCTIONS,
            prompt: PROMPT,
            greedy: true,
            guardrails: 'permissive-content-transformations',
        });
        expect(greedy).toContain('-g');
        expect(greedy).toContain('--guardrails');
        expect(greedy[greedy.indexOf('--guardrails') + 1]).toBe('permissive-content-transformations');
        // Prompt stays the final positional argument.
        expect(greedy[greedy.length - 1]).toBe(PROMPT);

        const plain = respondArgv({ schemaPath: '/s', instructions: INSTRUCTIONS, prompt: PROMPT });
        expect(plain).not.toContain('-g');
        expect(plain).not.toContain('--guardrails');
    });

    it('availability probe is `fm available --model system`, never bare `fm available`', () => {
        expect(availableArgv()).toEqual(['available', '--model', 'system']);
    });

    it('dash-leading prompts stay positional after the -- separator (task 0086 R4)', () => {
        for (const hostile of ['--help', '-n', '-']) {
            expect(countTokensArgv(INSTRUCTIONS, hostile).at(-1)).toBe(hostile);
            expect(countTokensArgv(INSTRUCTIONS, hostile).at(-2)).toBe('--');
            expect(respondArgv({ schemaPath: '/s', instructions: INSTRUCTIONS, prompt: hostile }).at(-1)).toBe(hostile);
            expect(respondArgv({ schemaPath: '/s', instructions: INSTRUCTIONS, prompt: hostile }).at(-2)).toBe('--');
        }
    });

    it('instructions containing newlines or flag-like text ride in the --instructions value (task 0086 R4)', () => {
        const hostile = '--schema /etc/passwd\n- bullet';
        expect(countTokensArgv(hostile, PROMPT)[2]).toBe(`--instructions=${hostile}`);
    });
});

describe('fm process runs and error mapping (task 0084 R7, R8)', () => {
    it('probe: exit 0 resolves; non-zero exit carries the fm reason', async () => {
        await expect(
            probeFmAvailability(new StubFmExecutor({ stdout: 'System model available' }), 'fm'),
        ).resolves.toBeUndefined();
        const unavailable = new StubFmExecutor({ exitCode: 1, stdout: 'System model unavailable: modelNotReady' });
        await expect(probeFmAvailability(unavailable, 'fm')).rejects.toThrow(DecisionConfigError);
        await expect(probeFmAvailability(unavailable, 'fm')).rejects.toThrow(/modelNotReady/);
    });

    it('probe and runs: spawn failure (ENOENT) maps to DecisionConfigError "fm not found"', async () => {
        const spawnFails = new StubFmExecutor({ exitCode: null, outcome: 'error', stderr: 'spawn failed' });
        await expect(probeFmAvailability(spawnFails, 'fm')).rejects.toThrow(/fm not found/);
        await expect(countPromptTokens(spawnFails, 'fm', INSTRUCTIONS, PROMPT)).rejects.toThrow(/fm not found/);
        await expect(
            runFmRespond(
                spawnFails,
                'fm',
                respondArgv({ schemaPath: '/s', instructions: INSTRUCTIONS, prompt: PROMPT }),
                1000,
            ),
        ).rejects.toThrow(/fm not found/);
    });

    it('count-tokens parses the bare integer; unparseable output is a backend error', async () => {
        await expect(
            countPromptTokens(new StubFmExecutor({ stdout: ' 1234\n' }), 'fm', INSTRUCTIONS, PROMPT),
        ).resolves.toBe(1234);
        await expect(
            countPromptTokens(new StubFmExecutor({ stdout: 'not a number' }), 'fm', INSTRUCTIONS, PROMPT),
        ).rejects.toThrow(DecisionBackendError);
        await expect(
            countPromptTokens(new StubFmExecutor({ exitCode: 1, stderr: 'boom' }), 'fm', INSTRUCTIONS, PROMPT),
        ).rejects.toThrow(/count-tokens failed \(exit 1\): boom/);
    });

    it('runs respond with the per-sample timeout', async () => {
        const executor = new StubFmExecutor({ stdout: '{}' });
        await runFmRespond(
            executor,
            'fm',
            respondArgv({ schemaPath: '/s', instructions: INSTRUCTIONS, prompt: PROMPT }),
            7777,
        );
        expect(executor.calls).toHaveLength(1);
        expect(executor.calls[0]?.timeout).toBe(7777);
        expect(executor.calls[0]?.command).toBe('fm');
    });

    it('timeout outcome maps to DecisionTimeoutError carrying requestTimeoutMs', async () => {
        const timedOut = new StubFmExecutor({ outcome: 'timeout', exitCode: null });
        const error = await runFmRespond(timedOut, 'fm', ['respond'], 250).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DecisionTimeoutError);
        expect((error as DecisionTimeoutError).timeoutMs).toBe(250);
        // Message must not echo the argv — the prompt is user content (task 0086 R12).
        expect((error as Error).message).toBe('fm respond exceeded requestTimeoutMs (250)');
    });

    it('probe and count-tokens carry a deadline and map timeout to DecisionTimeoutError (task 0086 R12)', async () => {
        const timedOut = new StubFmExecutor({ outcome: 'timeout', exitCode: null });
        await expect(probeFmAvailability(timedOut, 'fm', 1234)).rejects.toThrow(DecisionTimeoutError);
        expect(timedOut.calls[0]?.timeout).toBe(1234);
        await expect(countPromptTokens(timedOut, 'fm', INSTRUCTIONS, PROMPT, 4321)).rejects.toThrow(
            DecisionTimeoutError,
        );
        expect(timedOut.calls[1]?.timeout).toBe(4321);
        // Defaults exist so existing callers keep working.
        const slow = new StubFmExecutor({ outcome: 'timeout', exitCode: null });
        await expect(probeFmAvailability(slow, 'fm')).rejects.toThrow(DecisionTimeoutError);
        expect(slow.calls[0]?.timeout).toBe(10_000);
    });

    it('context-size text maps to DecisionRequestError; guardrails text to DecisionBackendError', async () => {
        const context = new StubFmExecutor({
            exitCode: 1,
            stderr: "The session's transcript exceeded the model's context size.",
        });
        const contextError = await runFmRespond(context, 'fm', ['respond'], 1000).catch((e: unknown) => e);
        expect(contextError).toBeInstanceOf(DecisionRequestError);
        expect((contextError as Error).message).toContain("exceeded the model's context size");

        const guardrails = new StubFmExecutor({
            exitCode: 1,
            stderr: "The model's safety guardrails were triggered.",
        });
        const guardrailError = await runFmRespond(guardrails, 'fm', ['respond'], 1000).catch((e: unknown) => e);
        expect(guardrailError).toBeInstanceOf(DecisionBackendError);
        expect((guardrailError as Error).message).toContain('safety guardrails were triggered');
    });

    it('any other non-zero exit maps to DecisionBackendError carrying the fm text', async () => {
        const other = new StubFmExecutor({ exitCode: 2, stderr: 'Unknown option: --bogus' });
        const error = await runFmRespond(other, 'fm', ['respond'], 1000).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DecisionBackendError);
        expect((error as Error).message).toContain('Unknown option: --bogus');
        expect((error as Error).message).toContain('exit 2');
    });

    it('prefers stderr but falls back to stdout for fm text', async () => {
        const stdoutOnly = new StubFmExecutor({ exitCode: 1, stdout: 'System model unavailable: modelNotReady' });
        await expect(probeFmAvailability(stdoutOnly, 'fm')).rejects.toThrow(/modelNotReady/);
    });
});

describe('sample parsing (task 0084 R5, R7)', () => {
    it('parses one JSON object and reads by key', () => {
        expect(parseFmRespond('{"dept":"billing","refund":"yes"}')).toEqual({ dept: 'billing', refund: 'yes' });
    });

    it('non-JSON and non-object stdout are backend errors', () => {
        expect(() => parseFmRespond('not json')).toThrow(DecisionBackendError);
        expect(() => parseFmRespond('[1,2]')).toThrow(DecisionBackendError);
        expect(() => parseFmRespond('')).toThrow(DecisionBackendError);
    });

    it('a value outside the declared enum is a backend error, never an answer', () => {
        expect(requireEnumValue({ dept: 'billing' }, 'dept', ['billing', 'tech'])).toBe('billing');
        expect(() => requireEnumValue({ dept: 'legal' }, 'dept', ['billing', 'tech'])).toThrow(DecisionBackendError);
        expect(() => requireEnumValue({}, 'dept', ['billing'])).toThrow(DecisionBackendError);
    });
});
