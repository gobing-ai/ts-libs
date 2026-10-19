/**
 * The sampled-driver core (task 0114 R1–R6): validation order, session lifecycle,
 * bounded concurrency, enum enforcement and the frequency estimators. Failure
 * modes 1–11 from the task Design are each one test here.
 */
import { describe, expect, it } from 'bun:test';
import {
    createSampledDriver,
    DecisionBackendError,
    DecisionRequestError,
    extractJsonAnswer,
    q,
    type SampledDriverOptions,
    type SampleSession,
} from '../../src';

const QUESTIONS = {
    dept: q.choice('Pick a team', { billing: 'Invoices', tech: 'Bugs' }),
    urgency: q.score('How urgent?', ['Low', 'High']),
    refund: q.noul('Refund?'),
};

/** A scripted session: each `sample()` draws the next record (or throws it). */
function scriptedSession(
    draws: Array<Record<string, string> | Error>,
    onClose?: () => void,
): { open: () => Promise<SampleSession>; opened: number; closed: number } {
    const state = {
        opened: 0,
        closed: 0,
        open: async (): Promise<SampleSession> => {
            state.opened += 1;
            const queue = [...draws];
            return {
                sample: async () => {
                    const next = queue.shift();
                    if (next === undefined) throw new Error('stub exhausted');
                    if (next instanceof Error) throw next;
                    return next;
                },
                close: () => {
                    state.closed += 1;
                    onClose?.();
                },
            };
        },
    };
    return state;
}

function driverWith(draws: Array<Record<string, string> | Error>, extra: Partial<SampledDriverOptions> = {}) {
    const session = scriptedSession(draws);
    const driver = createSampledDriver({ name: 'test', open: session.open, ...extra });
    return { driver, session };
}

describe('createSampledDriver (task 0114 R1, R4)', () => {
    it('declares its name and sample-frequency estimator; deterministic collapses k to 1 (R4)', () => {
        const { driver } = driverWith([]);
        expect(driver.name).toBe('test');
        expect(driver.estimator).toEqual({ kind: 'sample-frequency', samples: 5, greedy: false });

        const greedy = createSampledDriver({
            name: 'g',
            deterministic: true,
            samples: 9,
            open: scriptedSession([]).open,
        });
        expect(greedy.estimator).toEqual({ kind: 'sample-frequency', samples: 1, greedy: true });
    });

    it('rejects a non-positive or fractional sample count at construction (R4)', () => {
        for (const samples of [0, -1, 2.5]) {
            expect(() => createSampledDriver({ name: 't', samples, open: scriptedSession([]).open })).toThrow(
                DecisionRequestError,
            );
            expect(() => createSampledDriver({ name: 't', samples, open: scriptedSession([]).open })).toThrow(
                `samples must be a positive integer; got ${samples}`,
            );
        }
    });

    it('rejects a non-positive or fractional concurrency at construction (R4)', () => {
        for (const concurrency of [0, -2, 1.5]) {
            expect(() => createSampledDriver({ name: 't', concurrency, open: scriptedSession([]).open })).toThrow(
                `concurrency must be a positive integer; got ${concurrency}`,
            );
        }
    });

    it('defaults samples to 5 and concurrency to 1 (R4)', () => {
        const { driver, session } = driverWith(
            Array.from({ length: 5 }, () => ({ dept: 'billing', urgency: '0', refund: 'yes' })),
        );
        return driver.ask({ state: 's', questions: QUESTIONS }).then(() => {
            expect(session.opened).toBe(1);
            expect(session.closed).toBe(1);
        });
    });
});

describe('sampling lifecycle (task 0114 R5)', () => {
    it('1. rejects an empty map before opening a session', async () => {
        const { driver, session } = driverWith([]);
        await expect(driver.ask({ state: 's', questions: {} })).rejects.toThrow('expected a nonempty question map');
        expect(session.opened).toBe(0);
    });

    it('2. rejects a question with fewer than two options before opening a session', async () => {
        const { driver, session } = driverWith([]);
        await expect(driver.ask({ state: 's', questions: { one: q.choice('Pick', { only: 'One' }) } })).rejects.toThrow(
            "question 'one' has fewer than two options (1)",
        );
        expect(session.opened).toBe(0);
    });

    it('3. propagates a throwing open with no session to close', async () => {
        let closed = 0;
        const driver = createSampledDriver({
            name: 't',
            open: async () => {
                throw new Error('open failed');
            },
        });
        const session = scriptedSession([], () => {
            closed += 1;
        });
        expect(session.closed).toBe(0);
        await expect(driver.ask({ state: 's', questions: QUESTIONS })).rejects.toThrow('open failed');
        expect(closed).toBe(0);
    });

    it('4. a failing draw rejects the ask and closes the session exactly once', async () => {
        const { driver, session } = driverWith([
            { dept: 'billing', urgency: '0', refund: 'yes' },
            new Error('draw 2 failed'),
            { dept: 'tech', urgency: '1', refund: 'no' },
        ]);
        await expect(driver.ask({ state: 's', questions: QUESTIONS })).rejects.toThrow('draw 2 failed');
        expect(session.closed).toBe(1);
    });

    it('5. an out-of-enum value is a DecisionBackendError naming the key and the label', async () => {
        const { driver } = driverWith([{ dept: 'sales', urgency: '0', refund: 'yes' }], {
            samples: 1,
            sampleLabel: 'agent',
        });
        const error = await driver.ask({ state: 's', questions: QUESTIONS }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DecisionBackendError);
        expect((error as Error).message).toBe("agent sample for 'dept' violates the schema enum: 'sales'");
    });

    it('6. a missing key is a DecisionBackendError', async () => {
        const { driver } = driverWith([{ dept: 'billing', urgency: '0' }], { samples: 1 });
        const error = await driver.ask({ state: 's', questions: QUESTIONS }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DecisionBackendError);
        expect((error as Error).message).toContain("'refund'");
        expect((error as Error).message).toContain('(missing)');
    });

    it('7. a throwing close after success propagates', async () => {
        const driver = createSampledDriver({
            name: 't',
            samples: 1,
            open: async () => ({
                sample: async () => ({ dept: 'billing', urgency: '0', refund: 'yes' }),
                close: () => {
                    throw new Error('close failed');
                },
            }),
        });
        await expect(driver.ask({ state: 's', questions: QUESTIONS })).rejects.toThrow('close failed');
    });

    it('8. concurrency 2 with 5 samples never exceeds two in flight', async () => {
        let inFlight = 0;
        let peak = 0;
        const driver = createSampledDriver({
            name: 't',
            samples: 5,
            concurrency: 2,
            open: async () => ({
                sample: async () => {
                    inFlight += 1;
                    peak = Math.max(peak, inFlight);
                    await new Promise((resolve) => setTimeout(resolve, 1));
                    inFlight -= 1;
                    return { dept: 'billing', urgency: '0', refund: 'yes' };
                },
            }),
        });
        await driver.ask({ state: 's', questions: QUESTIONS });
        expect(peak).toBe(2);
    });

    it('9. deterministic runs exactly one sample with one-hot probabilities', async () => {
        const { driver } = driverWith([{ dept: 'tech', urgency: '1', refund: 'no' }], {
            deterministic: true,
            samples: 5,
        });
        const answers = await driver.ask({ state: 's', questions: QUESTIONS });
        expect(driver.estimator.greedy).toBe(true);
        expect(answers.dept).toEqual({
            kind: 'choice',
            label: 'tech',
            confidence: 1,
            probabilities: { billing: 0, tech: 1 },
        });
        expect(answers.refund).toEqual({ kind: 'noul', probability: 0 });
    });

    it('10. answers are empirical frequencies with declaration-order and lower-level tie-breaks', async () => {
        const { driver } = driverWith(
            [
                { dept: 'billing', urgency: '1', refund: 'yes' },
                { dept: 'billing', urgency: '1', refund: 'no' },
                { dept: 'tech', urgency: '0', refund: 'yes' },
                { dept: 'tech', urgency: '1', refund: 'no' },
                { dept: 'tech', urgency: '1', refund: 'yes' },
            ],
            { samples: 5 },
        );
        const answers = await driver.ask({ state: 's', questions: QUESTIONS });
        expect(answers.dept).toMatchObject({ label: 'tech', probabilities: { billing: 0.4, tech: 0.6 } });
        expect(answers.urgency).toMatchObject({ score: 1, probabilities: { 0: 0.2, 1: 0.8 } });
        expect(answers.refund).toEqual({ kind: 'noul', probability: 0.6 });

        // A 2/2 tie on a two-label choice goes to the first declared label.
        const tie = driverWith(
            [
                { dept: 'tech', urgency: '0', refund: 'yes' },
                { dept: 'billing', urgency: '0', refund: 'yes' },
                { dept: 'tech', urgency: '0', refund: 'yes' },
                { dept: 'billing', urgency: '0', refund: 'yes' },
            ],
            { samples: 4 },
        );
        const tied = await tie.driver.ask({ state: 's', questions: QUESTIONS });
        expect((tied.dept as { label: string }).label).toBe('billing');
        expect((tied.dept as { confidence: number }).confidence).toBeCloseTo(0, 12);
    });

    it('passes the rendered prompt and custom instructions to open (R5)', async () => {
        let seen: { instructions: string; prompt: string; model?: string } | undefined;
        const driver = createSampledDriver({
            name: 't',
            samples: 1,
            instructions: 'CUSTOM',
            open: async (ctx) => {
                seen = { instructions: ctx.instructions, prompt: ctx.prompt, model: ctx.model };
                return { sample: async () => ({ dept: 'billing', urgency: '0', refund: 'yes' }) };
            },
        });
        await driver.ask({ state: 'the state', questions: { dept: QUESTIONS.dept }, model: 'm-1' });
        expect(seen?.instructions).toBe('CUSTOM');
        expect(seen?.model).toBe('m-1');
        expect(seen?.prompt).toContain('Question "dept": Pick a team');
        expect(seen?.prompt).toContain('- billing: Invoices');
    });
});

describe('extractJsonAnswer (task 0114 R6)', () => {
    it('11. parses a bare object', () => {
        expect(extractJsonAnswer('{"a":"1"}')).toEqual({ a: '1' });
    });

    it('11. parses an object inside prose', () => {
        expect(extractJsonAnswer('I choose {"a":"1"} because.')).toEqual({ a: '1' });
    });

    it('11. parses a ```json fence', () => {
        expect(extractJsonAnswer('Here:\n```json\n{"a":"1"}\n```\nDone.')).toEqual({ a: '1' });
    });

    it('11. parses an untagged fence', () => {
        expect(extractJsonAnswer('```\n{"a":"2"}\n```')).toEqual({ a: '2' });
    });

    it('11. ignores braces inside strings', () => {
        expect(extractJsonAnswer('answer: {"a":"}{"} ok')).toEqual({ a: '}{' });
    });

    it('11. rejects a nested object value naming the key', () => {
        const error = (() => {
            try {
                extractJsonAnswer('{"a":{"b":"c"}}');
            } catch (thrown) {
                return thrown as Error;
            }
            return undefined;
        })();
        expect(error).toBeInstanceOf(DecisionBackendError);
        expect(error?.message).toContain("'a'");
    });

    it('11. rejects an array and a primitive', () => {
        expect(() => extractJsonAnswer('["a"]')).toThrow(DecisionBackendError);
        expect(() => extractJsonAnswer('42')).toThrow(DecisionBackendError);
    });

    it('11. rejects text with no JSON object', () => {
        const error = (() => {
            try {
                extractJsonAnswer('no json here');
            } catch (thrown) {
                return thrown as Error;
            }
            return undefined;
        })();
        expect(error).toBeInstanceOf(DecisionBackendError);
        expect(error?.message).toBe('no JSON object in sample output');
    });

    it('11. rejects a numeric value naming the key', () => {
        const error = (() => {
            try {
                extractJsonAnswer('{"a":7}');
            } catch (thrown) {
                return thrown as Error;
            }
            return undefined;
        })();
        expect(error).toBeInstanceOf(DecisionBackendError);
        expect(error?.message).toContain("'a'");
    });
});
