import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
    type ChoiceAnswer,
    createDecisionMaker,
    DecisionBackendError,
    DecisionConfigError,
    DecisionRequestError,
    DecisionTimeoutError,
    type NoulAnswer,
    q,
    type ScoreAnswer,
} from '@gobing-ai/ts-ai-runner';
import type { ProcessExecutor, ProcessOptions, ProcessResult } from '@gobing-ai/ts-runtime';
import { createFmDriver } from '../src/driver';

function baseResult(options: ProcessOptions, extra: Partial<ProcessResult>): ProcessResult {
    return {
        command: options.command,
        args: options.args ?? [],
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
        outcome: 'exit',
        ...extra,
    };
}

/** Scripted ProcessExecutor: `available`/`count-tokens` succeed, `respond` draws from a queue. */
class StubFmExecutor implements ProcessExecutor {
    readonly calls: ProcessOptions[] = [];

    constructor(private readonly respondResults: Array<Partial<ProcessResult>>) {}

    run(options: ProcessOptions): Promise<ProcessResult> {
        this.calls.push(options);
        const sub = options.args?.[0];
        if (sub === 'available') return Promise.resolve(baseResult(options, { stdout: 'System model available' }));
        if (sub === 'count-tokens') return Promise.resolve(baseResult(options, { stdout: '42' }));
        if (sub === 'respond') {
            const next = this.respondResults.shift();
            if (next === undefined) {
                return Promise.resolve(baseResult(options, { exitCode: 1, stderr: 'stub exhausted' }));
            }
            return Promise.resolve(baseResult(options, next));
        }
        return Promise.reject(new Error(`unexpected subcommand: ${String(sub)}`));
    }

    runStreaming(): never {
        throw new Error('fm driver uses only buffered run()');
    }

    respondCalls(): ProcessOptions[] {
        return this.calls.filter((c) => c.args?.[0] === 'respond');
    }

    respondArgAt(call: number, flag: string): string | undefined {
        const args = this.respondCalls()[call]?.args;
        if (args === undefined) return undefined;
        return args[args.indexOf(flag) + 1];
    }
}

function stubExecutor(samples: Array<Record<string, string>>): StubFmExecutor {
    return new StubFmExecutor(samples.map((answers) => ({ stdout: JSON.stringify(answers) })));
}

const QUESTIONS = {
    dept: q.choice('Pick a team', { billing: 'Invoices', tech: 'Bugs' }),
    urgency: q.score('How urgent?', ['Low', 'High']),
    refund: q.noul('Refund?'),
};

function driverFor(executor: ProcessExecutor, options = {}): ReturnType<typeof createFmDriver> {
    return createFmDriver({ platform: 'darwin', arch: 'arm64', executor, ...options });
}

describe('createFmDriver (task 0084 R2, R8, R9)', () => {
    it('declares name fm-local and the sample-frequency estimator (R2)', () => {
        const driver = driverFor(stubExecutor([]));
        expect(driver.name).toBe('fm-local');
        expect(driver.estimator).toEqual({ kind: 'sample-frequency', samples: 5, greedy: false });
        // No sugar: the facade owns choice/score/noul convenience methods.
        const raw = driver as unknown as Record<string, unknown>;
        expect(raw.choice).toBeUndefined();
        expect(raw.score).toBeUndefined();
        expect(raw.noul).toBeUndefined();
    });

    it('deterministic mode declares one greedy sample (R2, AC4)', () => {
        const driver = driverFor(stubExecutor([]), { deterministic: true, samples: 9 });
        expect(driver.estimator).toEqual({ kind: 'sample-frequency', samples: 1, greedy: true });
    });

    it('rejects non-darwin or non-arm64 hosts at construction without spawning (R8)', () => {
        for (const [platform, arch] of [
            ['linux', 'arm64'],
            ['darwin', 'x64'],
            ['win32', 'arm64'],
        ] as const) {
            expect(() => createFmDriver({ platform, arch })).toThrow(DecisionConfigError);
            expect(() => createFmDriver({ platform, arch })).toThrow(/darwin arm64/);
        }
    });

    it("rejects a model other than undefined or 'system' before any spawn (R9)", async () => {
        const executor = stubExecutor([]);
        const driver = driverFor(executor);
        await expect(driver.ask({ state: 's', questions: QUESTIONS, model: 'gpt-4' })).rejects.toThrow(
            DecisionRequestError,
        );
        expect(executor.calls).toHaveLength(0);
    });

    it('rejects a question with fewer than two options before any spawn (R9)', async () => {
        const executor = stubExecutor([]);
        const driver = driverFor(executor);
        await expect(driver.ask({ state: 's', questions: { one: q.choice('Pick', { only: 'One' }) } })).rejects.toThrow(
            DecisionRequestError,
        );
        expect(executor.calls).toHaveLength(0);
    });

    it('rejects an empty question map (R9)', async () => {
        const driver = driverFor(stubExecutor([]));
        await expect(driver.ask({ state: 's', questions: {} })).rejects.toThrow(DecisionRequestError);
    });

    it('reports a missing fm binary as DecisionConfigError on first ask (R8)', async () => {
        // The executor surfaces ENOENT as an `error`-outcome result (run() does not
        // throw unless rejectOnError) — the driver maps it to "fm not found".
        const failing = new StubFmExecutor([]);
        failing.run = () =>
            Promise.resolve(
                baseResult(
                    { command: 'fm', args: [] },
                    { exitCode: null, outcome: 'error', stderr: 'spawn fm ENOENT' },
                ),
            );
        const driver = driverFor(failing);
        await expect(driver.ask({ state: 's', questions: QUESTIONS })).rejects.toThrow(DecisionConfigError);
        await expect(driver.ask({ state: 's', questions: QUESTIONS })).rejects.toThrow(/fm not found/);
    });

    it('caches the availability probe across asks (R8)', async () => {
        const executor = stubExecutor([
            { dept: 'billing', urgency: '1', refund: 'yes' },
            { dept: 'billing', urgency: '1', refund: 'yes' },
        ]);
        const driver = driverFor(executor, { samples: 1 });
        await driver.ask({ state: 's', questions: QUESTIONS });
        await driver.ask({ state: 's', questions: QUESTIONS });
        expect(executor.calls.filter((c) => c.args?.[0] === 'available')).toHaveLength(1);
    });

    it('pre-flight rejects an over-budget prompt before any respond (R4, AC6)', async () => {
        const scripted: ProcessExecutor = {
            run: async (options) => {
                if (options.args?.[0] === 'available') {
                    return baseResult(options, { stdout: 'System model available' });
                }
                return baseResult(options, { stdout: '7001' });
            },
            runStreaming: () => {
                throw new Error('unused');
            },
        };
        const error = await driverFor(scripted, { maxPromptTokens: 6000 })
            .ask({ state: 's', questions: QUESTIONS })
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DecisionRequestError);
        expect((error as Error).message).toContain('7001');
        expect((error as Error).message).toContain('6000');
    });

    it('at-budget counts (count == budget) proceed to sampling', async () => {
        const scripted: ProcessExecutor = {
            run: async (options) => {
                if (options.args?.[0] === 'available') {
                    return baseResult(options, { stdout: 'System model available' });
                }
                if (options.args?.[0] === 'count-tokens') return baseResult(options, { stdout: '6000' });
                return baseResult(options, { stdout: JSON.stringify({ dept: 'tech', urgency: '0', refund: 'no' }) });
            },
            runStreaming: () => {
                throw new Error('unused');
            },
        };
        const driver = driverFor(scripted, { maxPromptTokens: 6000, samples: 1 });
        await expect(driver.ask({ state: 's', questions: QUESTIONS })).resolves.toBeDefined();
    });

    it('runs exactly k sequential respond calls on one schema file and deletes it (R3, R5)', async () => {
        const executor = stubExecutor([
            { dept: 'billing', urgency: '1', refund: 'yes' },
            { dept: 'tech', urgency: '0', refund: 'no' },
        ]);
        const driver = driverFor(executor, { samples: 2 });
        const answers = await driver.ask({ state: 'invoice state', questions: QUESTIONS });
        expect(executor.respondCalls()).toHaveLength(2);
        // Both samples shared the single per-ask schema file.
        expect(executor.respondArgAt(0, '--schema')).toBe(executor.respondArgAt(1, '--schema'));
        const schemaPath = executor.respondArgAt(0, '--schema');
        expect(schemaPath).toContain('fm-schema-');
        expect(existsSync(schemaPath as string)).toBe(false);
        // Sampling is sequential: every respond call carries the full prompt.
        expect(executor.respondArgAt(1, '-i')).toBeDefined();
        // 50/50 split: declaration-order tie-break picks 'billing', agreement ~0.
        const dept = answers.dept as ChoiceAnswer<string>;
        expect(dept.label).toBe('billing');
        expect(dept.probabilities).toEqual({ billing: 0.5, tech: 0.5 });
        expect(dept.confidence).toBeCloseTo(0, 12);
    });

    it('writes the schema with x-order/enums to the temp file fm reads (R3, AC5)', async () => {
        const seen: string[] = [];
        const scripted: ProcessExecutor = {
            run: async (options) => {
                const sub = options.args?.[0];
                if (sub === 'available') return baseResult(options, { stdout: 'System model available' });
                if (sub === 'count-tokens') return baseResult(options, { stdout: '42' });
                const args = options.args ?? [];
                const schemaPath = args[args.indexOf('--schema') + 1];
                if (typeof schemaPath === 'string') seen.push(await readFile(schemaPath, 'utf-8'));
                return baseResult(options, {
                    stdout: JSON.stringify({ dept: 'billing', urgency: '1', refund: 'yes' }),
                });
            },
            runStreaming: () => {
                throw new Error('unused');
            },
        };
        const driver = driverFor(scripted, { samples: 1 });
        await driver.ask({ state: 's', questions: QUESTIONS });
        const schema = JSON.parse(seen[0] as string) as Record<string, unknown>;
        expect(schema['x-order']).toEqual(['dept', 'urgency', 'refund']);
        expect(schema.required).toEqual(['dept', 'urgency', 'refund']);
        expect(schema.additionalProperties).toBe(false);
        expect(schema.properties).toEqual({
            dept: { type: 'string', enum: ['billing', 'tech'] },
            urgency: { type: 'string', enum: ['0', '1'] },
            refund: { type: 'string', enum: ['yes', 'no'] },
        });
    });

    it('answers per question kind from sample frequencies (R6, AC3)', async () => {
        const executor = stubExecutor([
            { dept: 'billing', urgency: '1', refund: 'yes' },
            { dept: 'billing', urgency: '0', refund: 'no' },
            { dept: 'tech', urgency: '1', refund: 'yes' },
            { dept: 'billing', urgency: '1', refund: 'yes' },
        ]);
        const driver = driverFor(executor, { samples: 4 });
        const answers = await driver.ask({ state: 's', questions: QUESTIONS });
        const dept = answers.dept as ChoiceAnswer<string>;
        expect(dept.label).toBe('billing');
        expect(dept.probabilities).toEqual({ billing: 0.75, tech: 0.25 });
        expect(dept.confidence).toBeCloseTo(1 - (-0.75 * Math.log(0.75) - 0.25 * Math.log(0.25)) / Math.log(2), 12);
        const urgency = answers.urgency as ScoreAnswer;
        expect(urgency.score).toBe(1);
        expect(urgency.probabilities).toEqual({ 0: 0.25, 1: 0.75 });
        expect(urgency.legend).toEqual({ 0: 'Low', 1: 'High' });
        const refund = answers.refund as NoulAnswer;
        expect(refund).toEqual({ kind: 'noul', probability: 0.75 });
        expect('confidence' in refund).toBe(false);
    });

    it('deterministic mode runs exactly one respond with -g and answers one-hot (AC4)', async () => {
        const executor = stubExecutor([{ dept: 'tech', urgency: '0', refund: 'no' }]);
        const driver = driverFor(executor, { deterministic: true });
        const answers = await driver.ask({ state: 's', questions: QUESTIONS });
        expect(executor.respondCalls()).toHaveLength(1);
        expect(executor.respondCalls()[0]?.args).toContain('-g');
        expect((answers.dept as ChoiceAnswer<string>).probabilities).toEqual({ billing: 0, tech: 1 });
        expect((answers.dept as ChoiceAnswer<string>).confidence).toBe(1);
        expect((answers.urgency as ScoreAnswer).score).toBe(0);
        expect((answers.refund as NoulAnswer).probability).toBe(0);
    });

    it('passes --guardrails only when the option is set (R5)', async () => {
        const withFlag = stubExecutor([{ dept: 'billing', urgency: '0', refund: 'yes' }]);
        const driver = driverFor(withFlag, {
            guardrails: 'permissive-content-transformations',
            samples: 1,
        });
        await driver.ask({ state: 's', questions: QUESTIONS });
        const args = withFlag.respondCalls()[0]?.args ?? [];
        const gi = args.indexOf('--guardrails');
        expect(gi).toBeGreaterThan(-1);
        expect(args[gi + 1]).toBe('permissive-content-transformations');

        const bare = stubExecutor([{ dept: 'billing', urgency: '0', refund: 'yes' }]);
        await driverFor(bare, { samples: 1 }).ask({ state: 's', questions: QUESTIONS });
        expect(bare.respondCalls()[0]?.args).not.toContain('--guardrails');
    });

    it('one failed sample fails the whole ask — no partial estimate (design § Errors)', async () => {
        const executor = new StubFmExecutor([
            { stdout: JSON.stringify({ dept: 'billing', urgency: '1', refund: 'yes' }) },
            { exitCode: 1, stderr: 'boom' },
        ]);
        const driver = driverFor(executor, { samples: 3 });
        const error = await driver.ask({ state: 's', questions: QUESTIONS }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DecisionBackendError);
        // Stopped at the failure, not silently retried through k.
        expect(executor.respondCalls()).toHaveLength(2);
    });

    it('executor timeouts surface as DecisionTimeoutError (R7)', async () => {
        const executor = new StubFmExecutor([{ outcome: 'timeout', exitCode: null }]);
        const driver = driverFor(executor, { samples: 2, requestTimeoutMs: 1234 });
        const error = await driver.ask({ state: 's', questions: QUESTIONS }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DecisionTimeoutError);
        expect((error as DecisionTimeoutError).timeoutMs).toBe(1234);
    });

    it('substitutes into createDecisionMaker from ts-ai-runner (AC2)', async () => {
        const dm = createDecisionMaker({
            driver: driverFor(stubExecutor([{ dept: 'billing', urgency: '1', refund: 'yes' }]), { samples: 1 }),
        });
        const result = await dm.ask({ state: 'Invoice was double billed', questions: QUESTIONS });
        expect(result.dept.label).toBe('billing');
        expect(result.urgency.score).toBe(1);
        expect(result.refund.probability).toBe(1);
    });

    it('cleans up the schema file when sampling fails (R3, finally)', async () => {
        const executor = new StubFmExecutor([{ exitCode: 1, stderr: 'The model failed.' }]);
        const driver = driverFor(executor, { samples: 1 });
        await expect(driver.ask({ state: 's', questions: QUESTIONS })).rejects.toThrow(DecisionBackendError);
        const schemaPath = executor.respondArgAt(0, '--schema');
        expect(schemaPath).toBeDefined();
        expect(existsSync(schemaPath as string)).toBe(false);
    });
});
