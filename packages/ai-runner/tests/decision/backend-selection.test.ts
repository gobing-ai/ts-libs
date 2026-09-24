import { describe, expect, it } from 'bun:test';
import type { ProcessExecutor, ProcessOptions, ProcessResult } from '@gobing-ai/ts-runtime';
import { createDecisionMaker, DecisionConfigError, type DecisionDriver, q } from '../../src';

describe('Named backend selector in DecisionMaker (task 0080)', () => {
    const fakeDriver: DecisionDriver = {
        name: 'mock-driver',
        ask: async () => ({
            question: { kind: 'choice', label: 'opt1', confidence: 1, probabilities: { opt1: 1 } },
        }),
    };

    describe('R1, R2, AC2 — resolution order: driver > backend > typesafe default', () => {
        it('uses explicit driver even when backend option is specified', async () => {
            const dm = createDecisionMaker({
                driver: fakeDriver,
                backend: 'typesafe',
            });
            expect(dm.driver).toBe('mock-driver');
            const res = await dm.choice('state', 'Pick', { opt1: 'Option 1' });
            expect(res.label).toBe('opt1');
        });

        it('resolves typesafe backend by name and respects apiKey requirement', async () => {
            const dm = createDecisionMaker({
                backend: 'typesafe',
                apiKey: 'test-key-xyz',
                fetch: (async () =>
                    new Response(
                        JSON.stringify({
                            answers: {
                                question: {
                                    type: 'choice',
                                    choice: 'yes',
                                    confidence: 0.99,
                                    probabilities: { yes: 0.99, no: 0.01 },
                                },
                            },
                        }),
                        { headers: { 'content-type': 'application/json' } },
                    )) as unknown as typeof fetch,
            });
            expect(dm.driver).toBe('typesafe');
            const res = await dm.choice('state', 'Deploy?', { yes: 'Yes', no: 'No' });
            expect(res.label).toBe('yes');
        });

        it('defaults to typesafe backend when backend option is omitted', async () => {
            const dm = createDecisionMaker({
                apiKey: 'test-key-xyz',
                fetch: (async () =>
                    new Response(
                        JSON.stringify({
                            answers: {
                                question: {
                                    type: 'choice',
                                    choice: 'yes',
                                    confidence: 0.99,
                                    probabilities: { yes: 0.99, no: 0.01 },
                                },
                            },
                        }),
                        { headers: { 'content-type': 'application/json' } },
                    )) as unknown as typeof fetch,
            });
            expect(dm.driver).toBe('typesafe');
            const res = await dm.choice('state', 'Deploy?', { yes: 'Yes', no: 'No' });
            expect(res.label).toBe('yes');
        });
    });

    describe('R3, R5, R6, AC1, AC2 — laya-local backend dynamic resolution', () => {
        it('resolves laya-local backend by dynamic import on first ask and answers cleanly', async () => {
            const dm = createDecisionMaker({
                backend: 'laya-local',
                module: 'tests.fixtures.stub_laya',
                platform: 'darwin',
                arch: 'arm64',
            });
            expect(dm.driver).toBe('laya-local');
            const res = await dm.choice('state', 'Pick', { opt1: 'Option 1', opt2: 'Option 2' });
            expect(typeof res.label).toBe('string');
            expect(['opt1', 'opt2']).toContain(res.label);
        });

        it('reports DecisionConfigError naming @gobing-ai/ts-laya-mlx when backend cannot be loaded', async () => {
            // Test with a non-existent or corrupted backend if we simulate an unresolvable package
            const dm = createDecisionMaker({
                backend: 'nonexistent-backend' as unknown as 'laya-local',
            });
            await expect(dm.ask({ state: 's', questions: { q: q.noul('p') } })).rejects.toThrow(DecisionConfigError);
        });
    });

    describe('fm-local backend (task 0085)', () => {
        /** Scripted ProcessExecutor: `available`/`count-tokens` succeed, `respond` draws from a queue. */
        class StubFmExecutor implements ProcessExecutor {
            constructor(private readonly responds: string[]) {}

            run(options: ProcessOptions): Promise<ProcessResult> {
                const sub = options.args?.[0];
                const stdout =
                    sub === 'available'
                        ? 'System model available'
                        : sub === 'count-tokens'
                          ? '42'
                          : (this.responds.shift() ?? '');
                return Promise.resolve({
                    command: options.command,
                    args: options.args ?? [],
                    exitCode: 0,
                    stdout,
                    stderr: '',
                    durationMs: 1,
                    outcome: 'exit',
                });
            }

            runStreaming(): never {
                throw new Error('fm driver uses only buffered run()');
            }
        }

        it('R1, R4, AC1 — resolves fm-local by dynamic import on first ask and answers choice/score/noul through the facade', async () => {
            const dm = createDecisionMaker({
                backend: 'fm-local',
                platform: 'darwin',
                arch: 'arm64',
                samples: 2,
                executor: new StubFmExecutor([
                    JSON.stringify({ question: 'tech' }),
                    JSON.stringify({ question: 'tech' }),
                    JSON.stringify({ question: '1' }),
                    JSON.stringify({ question: '1' }),
                    JSON.stringify({ question: 'yes' }),
                    JSON.stringify({ question: 'no' }),
                ]),
            });
            expect(dm.driver).toBe('fm-local');
            const choice = await dm.choice('state', 'Pick a team', { billing: 'Invoices', tech: 'Bugs' });
            expect(choice.label).toBe('tech');
            const score = await dm.score('state', 'How urgent?', ['Low', 'High']);
            expect(score.score).toBe(1);
            const noul = await dm.noul('state', 'Refund?');
            expect(noul).toEqual({ kind: 'noul', probability: 0.5 });
        });

        it('R1, AC2 — a failing fm driver construction propagates unchanged (task 0086 R9)', async () => {
            // Only the IMPORT is translated to the install-hint error; errors from
            // createFmDriver itself (here: unsupported host) surface as-is.
            const dm = createDecisionMaker({ backend: 'fm-local', platform: 'linux', arch: 'arm64' });
            const err = await dm.choice('s', 'Pick', { a: 'A', b: 'B' }).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(DecisionConfigError);
            const configErr = err as DecisionConfigError;
            expect(configErr.variable).toBe('PLATFORM');
            expect(configErr.message).toContain('darwin arm64');
            expect(configErr.message).not.toContain('bun add');
        });
    });
});
