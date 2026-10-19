/**
 * Byte-for-byte answer parity for the fm driver (task 0114 R9, Plan step 1).
 *
 * The recorded `output/fm-parity.json` is generated once against the
 * pre-refactor driver and committed; every later run compares against it. It is
 * the repeatable artifact that proves moving the sampling core into
 * `ts-ai-runner` changed no answer, probability, confidence or error.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { q } from '@gobing-ai/ts-ai-runner';
import type { ProcessExecutor, ProcessOptions, ProcessResult } from '@gobing-ai/ts-runtime';
import { createFmDriver } from '../src/driver';

const OUTPUT = join(import.meta.dir, 'output', 'fm-parity.json');

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
    constructor(private readonly respondResults: Array<Partial<ProcessResult>>) {}

    run(options: ProcessOptions): Promise<ProcessResult> {
        const sub = options.args?.[0];
        if (sub === 'available') return Promise.resolve(baseResult(options, { stdout: 'System model available' }));
        if (sub === 'count-tokens') return Promise.resolve(baseResult(options, { stdout: '42' }));
        if (sub === 'respond') {
            const next = this.respondResults.shift();
            if (next === undefined)
                return Promise.resolve(baseResult(options, { exitCode: 1, stderr: 'stub exhausted' }));
            return Promise.resolve(baseResult(options, next));
        }
        return Promise.reject(new Error(`unexpected subcommand: ${String(sub)}`));
    }

    runStreaming(): never {
        throw new Error('fm driver uses only buffered run()');
    }
}

const QUESTIONS = {
    dept: q.choice('Pick a team', { billing: 'Invoices', tech: 'Bugs', ops: 'Runtime' }),
    urgency: q.score('How urgent?', ['Low', 'Medium', 'High']),
    refund: q.noul('Refund?'),
};

function driverFor(executor: ProcessExecutor, options = {}): ReturnType<typeof createFmDriver> {
    return createFmDriver({ platform: 'darwin', arch: 'arm64', executor, ...options });
}

function stubExecutor(samples: Array<Record<string, string>>): StubFmExecutor {
    return new StubFmExecutor(samples.map((answers) => ({ stdout: JSON.stringify(answers) })));
}

/** Snapshot one case as either its answers or its error class + message. */
async function snapshot(run: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    try {
        return { answers: await run() };
    } catch (error) {
        return {
            errorClass: (error as Error).name,
            message: (error as Error).message,
        };
    }
}

const CASES: Array<{ name: string; run: () => Promise<Record<string, unknown>> }> = [
    {
        // (a) mixed choice/score/noul, 5 samples, choice tie broken by declaration order.
        name: 'mixed-map-with-tie',
        run: () =>
            snapshot(() =>
                driverFor(
                    stubExecutor([
                        { dept: 'billing', urgency: '1', refund: 'yes' },
                        { dept: 'tech', urgency: '1', refund: 'no' },
                        { dept: 'billing', urgency: '2', refund: 'yes' },
                        { dept: 'tech', urgency: '0', refund: 'yes' },
                        { dept: 'ops', urgency: '1', refund: 'no' },
                    ]),
                    { samples: 5 },
                ).ask({ state: 'A double-billed invoice', questions: QUESTIONS }),
            ),
    },
    {
        // (b) deterministic: one greedy sample, one-hot probabilities.
        name: 'deterministic',
        run: () =>
            snapshot(() =>
                driverFor(stubExecutor([{ dept: 'tech', urgency: '2', refund: 'no' }]), {
                    deterministic: true,
                    samples: 5,
                }).ask({ state: 'A double-billed invoice', questions: QUESTIONS }),
            ),
    },
    {
        // (c) a sample outside the declared enum.
        name: 'enum-violation',
        run: () =>
            snapshot(() =>
                driverFor(stubExecutor([{ dept: 'sales', urgency: '1', refund: 'yes' }]), { samples: 1 }).ask({
                    state: 'A double-billed invoice',
                    questions: QUESTIONS,
                }),
            ),
    },
    {
        // (d) non-JSON stdout.
        name: 'non-json-stdout',
        run: () =>
            snapshot(() =>
                driverFor(new StubFmExecutor([{ stdout: 'I think billing.' }]), { samples: 1 }).ask({
                    state: 'A double-billed invoice',
                    questions: QUESTIONS,
                }),
            ),
    },
    {
        // (e) over the prompt-token budget.
        name: 'over-budget',
        run: () =>
            snapshot(() => {
                const scripted: ProcessExecutor = {
                    run: async (options) =>
                        options.args?.[0] === 'available'
                            ? baseResult(options, { stdout: 'System model available' })
                            : baseResult(options, { stdout: '7001' }),
                    runStreaming: () => {
                        throw new Error('unused');
                    },
                };
                return driverFor(scripted, { maxPromptTokens: 6000 }).ask({
                    state: 'A double-billed invoice',
                    questions: QUESTIONS,
                });
            }),
    },
    {
        // (f) a model other than the on-device system model.
        name: 'bad-model',
        run: () =>
            snapshot(() =>
                driverFor(stubExecutor([]), { samples: 1 }).ask({
                    state: 'A double-billed invoice',
                    questions: QUESTIONS,
                    model: 'gpt-4',
                }),
            ),
    },
    {
        // (g) an empty question map.
        name: 'empty-map',
        run: () =>
            snapshot(() =>
                driverFor(stubExecutor([]), { samples: 1 }).ask({ state: 'A double-billed invoice', questions: {} }),
            ),
    },
];

describe('fm answer parity (task 0114 R9)', () => {
    it('matches the recorded pre-refactor fixture byte for byte', async () => {
        const actual: Record<string, unknown> = {};
        for (const testCase of CASES) actual[testCase.name] = await testCase.run();

        if (!existsSync(OUTPUT)) {
            mkdirSync(join(import.meta.dir, 'output'), { recursive: true });
            writeFileSync(OUTPUT, `${JSON.stringify(actual, null, 2)}\n`);
        }

        expect(actual).toEqual(JSON.parse(readFileSync(OUTPUT, 'utf-8')));
    });
});
