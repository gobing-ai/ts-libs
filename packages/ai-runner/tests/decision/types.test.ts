import { expect, test } from 'bun:test';
import type {
    Answer,
    AnswerFor,
    AnswersFor,
    ChoiceAnswer,
    DecisionDriver,
    Desc,
    NoulAnswer,
    NoulQuestion,
    Question,
    ScoreAnswer,
    ScoreQuestion,
} from '../../src/decision/types';
import { q } from '../../src/decision/types';

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// --- Type level: label-union inference (R3) ---

const category = q.choice('What is this ticket about?', { billing: null, technical: null, other: null });
type InferredLabels = typeof category.labels extends Record<infer L, Desc> ? L : never;
export type _labelsStayUnion = Expect<Equal<InferredLabels, 'billing' | 'technical' | 'other'>>;

declare const choiceAnswer: AnswerFor<typeof category>;
export type _labelIsUnion = Expect<Equal<typeof choiceAnswer.label, 'billing' | 'technical' | 'other'>>;
export type _probabilitiesKeyed = Expect<
    Equal<typeof choiceAnswer.probabilities, Record<'billing' | 'technical' | 'other', number>>
>;
export type _confidencePresent = Expect<Equal<'confidence' extends keyof typeof choiceAnswer ? true : false, true>>;

// A widened `Record<string, ...>` label map must NOT satisfy the union-typed answer.
const wide = q.choice('widened', { billing: null } as Record<'billing', Desc>);
declare const wideAnswer: AnswerFor<typeof wide>;
export type _wideLabel = Expect<Equal<typeof wideAnswer.label, 'billing'>>;

// --- Type level: rubric minimum (R4) ---

export type _rubricIsTuple = Expect<Equal<ScoreQuestion['rubric'], readonly [Desc, Desc, ...Desc[]]>>;

const rubric = ['not urgent', 'this week', 'immediate'] as const;
export type _rubricInference = Expect<Equal<typeof rubric, readonly ['not urgent', 'this week', 'immediate']>>;

// --- Type level: NoulAnswer carries exactly kind + probability (R2) ---

export type _noConfidenceOnNoul = Expect<Equal<'confidence' extends keyof NoulAnswer ? true : false, false>>;
export type _noulMembersExact = Expect<Equal<keyof NoulAnswer, 'kind' | 'probability'>>;

// --- Type level: conditional answer mapping ---

type BatchAnswers = AnswersFor<{ category: typeof category; urgency: ScoreQuestion; refund: NoulQuestion }>;
export type _choiceMaps = Expect<Equal<BatchAnswers['category'], ChoiceAnswer<'billing' | 'technical' | 'other'>>>;
export type _scoreMaps = Expect<Equal<BatchAnswers['urgency'], ScoreAnswer>>;
export type _noulMaps = Expect<Equal<BatchAnswers['refund'], NoulAnswer>>;

export type _unionIncludesAll = Expect<
    Equal<Answer extends ChoiceAnswer<string> | ScoreAnswer | NoulAnswer ? true : false, true>
>;

// --- Type level: negative cases ---

// @ts-expect-error a one-level rubric violates the two-level minimum (R4)
q.score('too shallow', ['only']);
// @ts-expect-error a ScoreQuestion without a rubric is invalid
const _badScore: ScoreQuestion = { kind: 'score', prompt: 'missing rubric' };

test('noulAnswer has no confidence member at runtime or in type (R2)', () => {
    const noulAnswer: NoulAnswer = { kind: 'noul', probability: 0.9 };
    expect(Object.keys(noulAnswer).sort()).toEqual(['kind', 'probability']);
    // @ts-expect-error NoulAnswer has no confidence member (R2)
    void noulAnswer.confidence;
});

test('q builders return the right discriminants and shapes', () => {
    expect(category.kind).toBe('choice');
    expect(category.prompt).toBe('What is this ticket about?');
    expect(category.labels).toEqual({ billing: null, technical: null, other: null });

    const urgency = q.score('How urgent is it?', ['not urgent', 'this week', 'immediate']);
    expect(urgency.kind).toBe('score');
    expect(urgency.rubric).toEqual(['not urgent', 'this week', 'immediate']);

    const refund = q.noul('Is the customer asking for a refund?');
    expect(refund.kind).toBe('noul');
    expect(refund.prompt).toBe('Is the customer asking for a refund?');
    expect(refund).toEqual({ kind: 'noul', prompt: 'Is the customer asking for a refund?' });

    const described = q.noul(undefined, { yes: 'refund requested', no: 'keep payment' });
    expect(described.yes).toBe('refund requested');
    expect(described.no).toBe('keep payment');
});

test('q.choice accepts structured and null descriptions', () => {
    const labelled = q.choice('Why?', { billing: ['money', { topic: 'invoices' }], technical: null });
    expect(labelled.labels.billing).toEqual(['money', { topic: 'invoices' }]);
});

test('questions satisfy the Question union', () => {
    const questions: Record<string, Question> = { category, urgency: q.score('u', [null, null]) };
    expect(Object.keys(questions)).toHaveLength(2);
});

test('a one-method fake driver satisfies DecisionDriver and answers as keyed', async () => {
    const driver: DecisionDriver = {
        name: 'fake',
        ask: async ({ questions }) =>
            Object.fromEntries(Object.keys(questions).map((key) => [key, { kind: 'noul', probability: 0.5 }])),
    };
    const answers = await driver.ask({
        state: { ticket: 'A2-7238' },
        questions: { refund: q.noul('refund?') },
    });
    expect(driver.name).toBe('fake');
    expect(answers.refund).toEqual({ kind: 'noul', probability: 0.5 });
});
