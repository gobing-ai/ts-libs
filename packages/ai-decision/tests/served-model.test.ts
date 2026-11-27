import { describe, expect, test } from 'bun:test';
import {
    type Answer,
    type AnswersFor,
    type ChoiceAnswer,
    createDecisionMaker,
    type DecisionMaker,
    type DecisionState,
    type NoulAnswer,
    type Question,
    q,
    type ScoreAnswer,
} from '@gobing-ai/ts-ai-runner';
import { createFmDriver } from '@gobing-ai/ts-decision-fm';
import {
    createAgentDriver,
    DecisionHub,
    DecisionMakerRegistry,
    type DecisionResult,
    parseDecisionCatalog,
} from '../src';
import { createTypesafeDriver } from '../src/typesafe-driver';
import { requestBodyText, streamedJson } from './helpers/sdk-fetch';

/**
 * Served model (P12 R3/R4/R5): the model a backend actually used reaches a hub result through the
 * optional `askWithMeta` seam, and only when a model-bearing answer was accepted.
 */

/** Injected fetch answering every `/v1/systemone` call from `answer` with a canned model. */
function stubFetch(respond: (body: Record<string, unknown>) => unknown): typeof fetch {
    return (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const text = requestBodyText(init);
        return streamedJson(respond(text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)));
    }) as typeof fetch;
}

/** One-decision choice catalog with a 0.5 confidence floor. */
const CATALOG = `version: 1
defaults:
  minConfidence: 0.5
decisions:
  pick:
    type: choice
    criteria: { alpha: First, beta: Second }
    fallback: beta
`;

/** A maker over the real typesafe driver, its wire stubbed, plus a hub serving only it. */
async function typesafeHub(respond: (body: Record<string, unknown>) => unknown): Promise<DecisionHub> {
    const registry = new DecisionMakerRegistry({ builtins: false });
    registry.register('typesafe', () =>
        createDecisionMaker({
            driver: createTypesafeDriver({ apiKey: 'test-key', fetch: stubFetch(respond), maxRetries: 0 }),
        }),
    );
    const hub = new DecisionHub({ registry, defaultMaker: 'typesafe', now: () => 0 });
    hub.load(await parseDecisionCatalog(CATALOG, 'inline-served-model.yaml'));
    return hub;
}

/** A `choice` answer body the SDK adapter accepts, at the given confidence. */
function choicePayload(model: unknown, confidence = 0.9): unknown {
    return {
        model,
        answers: {
            pick: {
                type: 'choice',
                choice: 'alpha',
                confidence,
                probabilities: { alpha: confidence, beta: 1 - confidence },
            },
        },
    };
}

/** A maker double for a backend whose driver implements only `ask` (fm-local, laya-local, llm-agent). */
class AskOnlyMaker implements DecisionMaker {
    readonly driver: string;
    constructor(name: string) {
        this.driver = name;
    }
    ask<const Q extends Record<string, Question>>(req: { state: DecisionState; questions: Q }): Promise<AnswersFor<Q>> {
        const answers = Object.fromEntries(
            Object.entries(req.questions).map(([name]) => [
                name,
                { kind: 'choice', label: 'alpha', confidence: 0.9, probabilities: { alpha: 0.9, beta: 0.1 } },
            ]),
        ) as unknown as AnswersFor<Q>;
        return Promise.resolve(answers);
    }
    choice<const L extends string>(): Promise<ChoiceAnswer<L>> {
        throw new Error('unused: the hub only calls ask');
    }
    score(): Promise<ScoreAnswer> {
        throw new Error('unused: the hub only calls ask');
    }
    noul(): Promise<NoulAnswer> {
        throw new Error('unused: the hub only calls ask');
    }
}

/** `servedModel` presence probe — absent means the key is missing, not undefined-valued. */
const hasServedModel = (result: DecisionResult): boolean => Object.hasOwn(result, 'servedModel');

describe('served model through askWithMeta (P12 R3/R4)', () => {
    test('R3 — the typesafe driver reports the served model from SystemOneResult.model', async () => {
        const driver = createTypesafeDriver({
            apiKey: 'test-key',
            fetch: stubFetch(() => choicePayload('m-x')),
            maxRetries: 0,
        });
        const meta = await driver.askWithMeta({
            state: 's',
            questions: { pick: q.choice('pick?', { alpha: '', beta: '' }) },
        });
        expect(meta.servedModel).toBe('m-x');
        expect(meta.answers.pick).toMatchObject({ kind: 'choice', label: 'alpha' });
        // `ask` keeps the answers-only shape, so nothing surfaces a model through it (R1).
        const answers = await driver.ask({
            state: 's',
            questions: { pick: q.choice('pick?', { alpha: '', beta: '' }) },
        });
        expect(answers.pick).toMatchObject({ kind: 'choice', label: 'alpha' });
        expect(Object.hasOwn(answers, 'servedModel')).toBe(false);
    });

    test('R4 — an accepted hub result carries servedModel', async () => {
        const hub = await typesafeHub(() => choicePayload('m-x'));
        const result = await hub.decide('pick');
        expect(result.source).toBe('model');
        expect(result).toMatchObject({ servedModel: 'm-x' });
    });

    test('R4 — a fallback result carries no servedModel', async () => {
        const hub = await typesafeHub(() => choicePayload('m-x', 0.2));
        const result = await hub.decide('pick');
        expect(result.reason).toBe('low-confidence');
        expect(result.source).toBe('default');
        expect(hasServedModel(result)).toBe(false);
    });

    test('R4 — answers arriving through askWithMeta are validated exactly as through ask', async () => {
        // An unknown choice label fails the shared validator, which the hub maps to an `error`
        // fallback instead of propagating a rejection.
        const hub = await typesafeHub(() => ({
            model: 'm-x',
            answers: {
                pick: { type: 'choice', choice: 'gamma', confidence: 0.9, probabilities: { gamma: 0.9 } },
            },
        }));
        const result = await hub.decide('pick');
        expect(result.reason).toBe('error');
        expect(result.value).toBe('beta');
        expect(hasServedModel(result)).toBe(false);
    });
});

describe('makers without the meta seam (P12 R5)', () => {
    test('R5 — the fm-local and llm-agent drivers do not implement askWithMeta', () => {
        // decision-fm refuses to construct off darwin/arm64 (its own platform guard, driver.ts:89), so
        // the driver-level assertion runs where it can exist; the maker-level case below covers the
        // fm-local shape everywhere.
        const fm = (() => {
            try {
                return createFmDriver({});
            } catch {
                return undefined;
            }
        })();
        if (fm !== undefined) expect(fm.askWithMeta).toBeUndefined();
        expect(createAgentDriver({}).askWithMeta).toBeUndefined();
    });

    test('R5 — fm-local, laya-local and llm-agent hub results carry no servedModel', async () => {
        for (const name of ['fm-local', 'laya-local', 'llm-agent']) {
            const registry = new DecisionMakerRegistry({ builtins: false });
            // laya-local's real driver is a dynamically imported optional package; its `ask`-only
            // shape is what this covers, identically to the two drivers asserted above.
            registry.register(name, new AskOnlyMaker(name));
            const hub = new DecisionHub({ registry, defaultMaker: name, now: () => 0 });
            hub.load(await parseDecisionCatalog(CATALOG, 'inline-served-model.yaml'));
            const result = await hub.decide('pick');
            expect({ name, source: result.source, served: hasServedModel(result) }).toEqual({
                name,
                source: 'model',
                served: false,
            });
        }
    });
});

/** Compile-time guard: the meta seam stays optional, so an `ask`-only Answer record is unchanged. */
const _askOnlyShape: Answer = { kind: 'noul', probability: 0.5 };
void _askOnlyShape;
