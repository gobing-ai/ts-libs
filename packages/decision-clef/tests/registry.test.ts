import { describe, expect, test } from 'bun:test';
import { DecisionHub, DecisionMakerRegistry, parseDecisionCatalog } from '@gobing-ai/ts-ai-decision';
import { createDecisionMaker, type DecisionDriver } from '@gobing-ai/ts-ai-runner';
import { createClefDriver } from '../src/driver';

const VALID_ACCOUNT = '0123456789abcdef0123456789abcdef';
const VALID_TOKEN = 'registry_test_token';

const CATALOG = `
version: 1
defaults:
  maker: clef-hosted
decisions:
  category:
    type: choice
    instructions: "Classify this ticket"
    criteria:
      bug: Something is broken
      billing: Money related
    fallback: bug
`;

/** A real Clef driver over an injected fetch that answers every question as a fixed choice. */
function clefDriverWithStubFetch(counter: { calls: number }): DecisionDriver {
    return createClefDriver({
        accountId: VALID_ACCOUNT,
        apiToken: VALID_TOKEN,
        fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
            counter.calls += 1;
            const body = JSON.parse(String(init?.body)) as { questions: Record<string, { type: string }> };
            const answers: Record<string, unknown> = {};
            for (const [key, question] of Object.entries(body.questions)) {
                if (question.type === 'choice') {
                    answers[key] = {
                        type: 'choice',
                        choice: 'bug',
                        confidence: 0.9,
                        probabilities: { bug: 0.9, billing: 0.1 },
                    };
                } else if (question.type === 'score') {
                    answers[key] = {
                        type: 'score',
                        score: 0,
                        confidence: 0.9,
                        legend: { 0: 'low', 1: 'high' },
                        probabilities: { 0: 0.9, 1: 0.1 },
                    };
                } else {
                    answers[key] = { type: 'noul', noul: 0.75 };
                }
            }
            return new Response(JSON.stringify({ success: true, result: { model: 'clef-flash', answers } }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }) as typeof fetch,
    });
}

describe('decision-clef registry and hub composition (R6)', () => {
    test('custom clef maker is registered by name, stays lazy, memoises and drives the hub', async () => {
        const counter = { calls: 0 };
        let factoryRuns = 0;

        const registry = new DecisionMakerRegistry({ builtins: false });
        registry.register('clef-hosted', () => {
            factoryRuns += 1;
            return createDecisionMaker({ driver: clefDriverWithStubFetch(counter) });
        });

        // Registration itself never constructs a maker or driver.
        expect(factoryRuns).toBe(0);
        expect(counter.calls).toBe(0);

        const hub = new DecisionHub({ registry, defaultMaker: 'clef-hosted', now: () => 0 });
        hub.load(await parseDecisionCatalog(CATALOG, 'inline.yaml'));

        expect(factoryRuns).toBe(0); // still lazy after load

        const result = await hub.decide('category');
        expect(result.maker).toBe('clef-hosted');
        expect(result.source).toBe('model');
        expect(result.type).toBe('choice');
        expect(result.value).toBe('bug');
        expect(factoryRuns).toBe(1);
        expect(counter.calls).toBe(1);

        // Second decide reuses the memoised maker — no new factory run, but a new HTTP call.
        await hub.decide('category');
        expect(factoryRuns).toBe(1);
        expect(counter.calls).toBe(2);

        expect(await registry.resolve('clef-hosted')).toBe(await registry.resolve('clef-hosted'));
    });

    test('registering clef does not change built-in maker names', () => {
        const registry = new DecisionMakerRegistry();
        expect(registry.names()).toEqual(['typesafe', 'fm-local', 'laya-local']);
        registry.register('clef-hosted', () => createDecisionMaker({ driver: clefDriverWithStubFetch({ calls: 0 }) }));
        expect(registry.names()).toEqual(['typesafe', 'fm-local', 'laya-local', 'clef-hosted']);
        expect(registry.has('clef')).toBe(false); // no built-in clef maker is added
    });

    test('hub routes per-decision maker override to the clef maker', async () => {
        const counter = { calls: 0 };
        const registry = new DecisionMakerRegistry({ builtins: false });
        registry.register('clef-hosted', () => createDecisionMaker({ driver: clefDriverWithStubFetch(counter) }));
        registry.register('other', () =>
            createDecisionMaker({
                driver: {
                    name: 'other',
                    ask: () => Promise.resolve({}),
                },
            }),
        );

        const hub = new DecisionHub({ registry, defaultMaker: 'other', now: () => 0 });
        hub.load(
            await parseDecisionCatalog(
                `
version: 1
defaults:
  maker: other
decisions:
  via_clef:
    type: choice
    instructions: "pick"
    criteria: { bug: broken, billing: money }
    maker: clef-hosted
    fallback: bug
`,
                'override.yaml',
            ),
        );

        const result = await hub.decide('via_clef');
        expect(result.maker).toBe('clef-hosted');
        expect(counter.calls).toBe(1);
    });

    test('hub fallback path is untouched when the clef backend fails', async () => {
        const registry = new DecisionMakerRegistry({ builtins: false });
        registry.register('clef-hosted', () =>
            createDecisionMaker({
                driver: createClefDriver({
                    accountId: VALID_ACCOUNT,
                    apiToken: VALID_TOKEN,
                    fetch: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
                }),
            }),
        );

        const hub = new DecisionHub({ registry, defaultMaker: 'clef-hosted', now: () => 0 });
        hub.load(await parseDecisionCatalog(CATALOG, 'failure.yaml'));

        const result = await hub.decide('category');
        expect(result.source).toBe('default');
        expect(result.value).toBe('bug'); // declared fallback, never fabricated by the driver
        expect(result.reason).not.toBe('accepted');
    });
});
