import { describe, expect, test } from 'bun:test';
import { createDecisionMaker, type DecisionMaker } from '../../src/decision/decision-maker';
import { DecisionConfigError } from '../../src/decision/errors';
import type {
    Answer,
    ChoiceAnswer,
    ChoiceQuestion,
    DecisionDriver,
    DecisionState,
    NoulAnswer,
    NoulQuestion,
    Question,
    ScoreAnswer,
    ScoreQuestion,
} from '../../src/decision/types';
import { q } from '../../src/decision/types';

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// --- Type level: facade narrowing (R3) — the driver's loose record comes back as AnswersFor<Q> ---
declare const dm: DecisionMaker;
type BatchQs = { category: ChoiceQuestion<'billing' | 'other'>; urgency: ScoreQuestion; refund: NoulQuestion };
type Narrowed = Awaited<ReturnType<typeof dm.ask<BatchQs>>>;
export type _askNarrows = Expect<Equal<Narrowed['category'], ChoiceAnswer<'billing' | 'other'>>>;
export type _scoreEntry = Expect<Equal<Narrowed['urgency'], ScoreAnswer>>;
export type _noulEntry = Expect<Equal<Narrowed['refund'], NoulAnswer>>;

/** Hand-written driver — no @typesafe-ai/sdk. Records every request, returns canned answers. */
function fakeDriver(
    answers: Record<string, Answer>,
    name = 'fake',
): {
    driver: DecisionDriver;
    calls: Array<{ state: DecisionState; questions: Record<string, Question>; model?: string }>;
} {
    const calls: Array<{ state: DecisionState; questions: Record<string, Question>; model?: string }> = [];
    return {
        calls,
        driver: {
            name,
            async ask(req) {
                calls.push(req);
                return answers;
            },
        },
    };
}

const CATEGORY: ChoiceAnswer<'billing' | 'other'> = {
    kind: 'choice',
    label: 'billing',
    confidence: 0.9,
    probabilities: { billing: 0.9, other: 0.1 },
};
const URGENCY: ScoreAnswer = {
    kind: 'score',
    score: 0.8,
    confidence: 0.8,
    legend: { 0: 'low', 1: 'high' },
    probabilities: { 0: 0.2, 1: 0.8 },
};
const REFUND: NoulAnswer = { kind: 'noul', probability: 0.75 };

/** The single driver call a test expects — throws (failing the test) when there is none. */
function onlyCall(calls: Array<{ state: DecisionState; questions: Record<string, Question>; model?: string }>) {
    const [call] = calls;
    if (calls.length !== 1 || !call) throw new Error(`expected exactly 1 driver call, got ${calls.length}`);
    return call;
}

describe('createDecisionMaker', () => {
    test('AC R1 — no-arg call returns an object with ask, choice, score, noul and the typesafe driver selected', () => {
        const dm = createDecisionMaker();
        expect(typeof dm.ask).toBe('function');
        expect(typeof dm.choice).toBe('function');
        expect(typeof dm.score).toBe('function');
        expect(typeof dm.noul).toBe('function');
        expect(dm.driver).toBe('typesafe');
    });

    test('R6 — creating with no key and no driver does not construct anything', () => {
        expect(() => createDecisionMaker({ env: {} })).not.toThrow();
    });

    test('AC R6 — missing key rejects on ask with DecisionConfigError naming TYPESAFE_API_KEY, fetch never invoked', async () => {
        let fetched = false;
        const spyFetch = (() => {
            fetched = true;
            throw new Error('network must not be reached');
        }) as unknown as typeof fetch;
        const dm = createDecisionMaker({ env: {}, fetch: spyFetch });
        const err = await dm.ask({ state: null, questions: {} }).then(
            () => null,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(DecisionConfigError);
        expect((err as DecisionConfigError).message).toContain('TYPESAFE_API_KEY');
        expect((err as DecisionConfigError).variable).toBe('TYPESAFE_API_KEY');
        expect(fetched).toBe(false);
    });

    test('R7 — injected env key satisfies resolution; failure is not a config error (default wiring is task 0072)', async () => {
        const dm = createDecisionMaker({ env: { TYPESAFE_API_KEY: 'test-key' } });
        const err = await dm.ask({ state: null, questions: {} }).then(
            () => null,
            (e: unknown) => e,
        );
        expect(err).not.toBeInstanceOf(DecisionConfigError);
        expect((err as Error).message).not.toContain('TYPESAFE_API_KEY');
    });

    test('R7 — explicit apiKey wins over an env record lacking the key', async () => {
        const dm = createDecisionMaker({ apiKey: 'explicit', env: {} });
        const err = await dm.ask({ state: null, questions: {} }).then(
            () => null,
            (e: unknown) => e,
        );
        expect(err).not.toBeInstanceOf(DecisionConfigError);
    });
});

describe('ask — batch passthrough (R3)', () => {
    test('forwards state, questions map, and model unchanged; narrows the answer record', async () => {
        const { driver, calls } = fakeDriver({ category: CATEGORY, urgency: URGENCY, refund: REFUND });
        const dm = createDecisionMaker({ driver });
        const questions = {
            category: q.choice('What is this ticket about?', { billing: null, other: null }),
            urgency: q.score('How urgent?', ['not urgent', 'immediate']),
            refund: q.noul('Refund requested?'),
        };
        const answers = await dm.ask({ state: { ticket: '123' }, questions, model: 'jev-latest' });

        expect(calls.length).toBe(1);
        expect(onlyCall(calls).state).toEqual({ ticket: '123' });
        expect(onlyCall(calls).questions).toBe(questions); // same reference — untouched
        expect(Object.keys(onlyCall(calls).questions)).toEqual(['category', 'urgency', 'refund']);
        expect(onlyCall(calls).model).toBe('jev-latest');

        // narrowing: each entry resolves to the answer type of its question
        const label: 'billing' | 'other' = answers.category.label;
        const score: number = answers.urgency.score;
        const probability: number = answers.refund.probability;
        expect(label).toBe('billing');
        expect(score).toBe(0.8);
        expect(probability).toBe(0.75);
    });
});

describe('sugar over ask (R4/R5)', () => {
    test('choice: exactly one driver call with exactly one choice question; resolves to the unwrapped answer', async () => {
        const { driver, calls } = fakeDriver({ question: CATEGORY });
        const dm = createDecisionMaker({ driver });

        const answer: ChoiceAnswer<'billing' | 'other'> = await dm.choice('a ticket', 'What is this?', {
            billing: null,
            other: null,
        });

        expect(calls.length).toBe(1); // one call — sugar issues no second driver call
        expect(Object.keys(onlyCall(calls).questions)).toEqual(['question']);
        const question = Object.values(onlyCall(calls).questions)[0];
        expect(question?.kind).toBe('choice');
        expect(answer).toEqual(CATEGORY); // the answer itself, not a map
    });

    test('score: one call, one score question, unwrapped ScoreAnswer', async () => {
        const { driver, calls } = fakeDriver({ question: URGENCY });
        const dm = createDecisionMaker({ driver });

        const answer = await dm.score('a ticket', 'How urgent?', ['not urgent', 'immediate']);

        expect(calls.length).toBe(1);
        expect(Object.keys(onlyCall(calls).questions)).toEqual(['question']);
        const question = Object.values(onlyCall(calls).questions)[0];
        expect(question?.kind).toBe('score');
        expect(answer).toEqual(URGENCY);
        expect(answer.score).toBe(0.8);
    });

    test('noul: one call, one noul question, unwrapped NoulAnswer', async () => {
        const { driver, calls } = fakeDriver({ question: REFUND });
        const dm = createDecisionMaker({ driver });

        const answer = await dm.noul('a ticket', 'Refund?', { yes: 'asked', no: 'not asked' });

        expect(calls.length).toBe(1);
        expect(Object.keys(onlyCall(calls).questions)).toEqual(['question']);
        const question = Object.values(onlyCall(calls).questions)[0];
        expect(question?.kind).toBe('noul');
        expect(answer).toEqual(REFUND);
        expect(answer.probability).toBe(0.75);
    });
});

describe('driver seam (AC R8)', () => {
    test('a custom driver with no key anywhere serves all four members unchanged', async () => {
        const calls: unknown[] = [];
        const driver: DecisionDriver = {
            name: 'alternate',
            async ask(req) {
                calls.push(req);
                return Object.fromEntries(
                    Object.entries(req.questions).map(([name, question]) => [
                        name,
                        question.kind === 'choice' ? CATEGORY : question.kind === 'score' ? URGENCY : REFUND,
                    ]),
                );
            },
        };
        const dm = createDecisionMaker({ driver }); // no env, no apiKey — must not matter

        expect(dm.driver).toBe('alternate');
        await dm.ask({ state: null, questions: { category: q.choice('c', { billing: null, other: null }) } });
        await dm.choice('s', 'p', { billing: null, other: null });
        await dm.score('s', 'p', ['a', 'b']);
        await dm.noul('s', 'p');

        expect(calls.length).toBe(4);
    });
});
