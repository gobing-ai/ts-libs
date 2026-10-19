/**
 * The deprecated `typesafe` backend bridge (task 0116 R5, R8).
 *
 * The driver moved to `@gobing-ai/ts-ai-decision`, so `createDecisionMaker()`'s
 * default backend now resolves it through a dynamic import. These cases pin the
 * split that matters: the API-key error still comes FIRST (before any import), an
 * unimportable package yields the install hint, a module without the export is a
 * distinct error, and construction errors propagate unchanged.
 */
import { describe, expect, it } from 'bun:test';
import {
    createDecisionMaker,
    DecisionConfigError,
    type DecisionMakerOptions,
    resolveApiKey,
    resolveTypesafeDriver,
} from '../../src';
import { streamedJson } from '../helpers/sdk-fetch';

/** A fetch that answers every systemOne call with a one-label choice payload. */
const okFetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // The SDK may compress the request body; the responder only needs the question names.
    const raw = init?.body;
    let names: string[] = ['answer'];
    try {
        const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as ArrayBuffer);
        names = Object.keys((JSON.parse(text) as { questions?: Record<string, unknown> }).questions ?? { answer: {} });
    } catch {
        // A compressed body leaves the default key; the payload below stays valid.
    }
    return streamedJson({
        model: 'jev-latest',
        answers: Object.fromEntries(
            names.map((name) => [name, { type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 } }]),
        ),
    });
}) as typeof fetch;

const failingImport = async (): Promise<never> => {
    throw new Error('Cannot find module');
};

const options = (extra: DecisionMakerOptions = {}): DecisionMakerOptions => ({
    apiKey: 'test-key',
    env: {},
    ...extra,
});

describe('typesafe bridge (task 0116 R5, R8)', () => {
    it('a. answers end to end through the real workspace @gobing-ai/ts-ai-decision', async () => {
        const maker = createDecisionMaker({ fetch: okFetch, env: {}, apiKey: 'test-key' });
        expect(maker.driver).toBe('typesafe');
        const answer = await maker.choice('state', 'Pick', { a: 'A', b: 'B' });
        expect(answer).toMatchObject({ kind: 'choice', label: 'a', confidence: 1 });
    });

    it('b. an unimportable package maps to the TYPESAFE_BACKEND install hint', async () => {
        const error = await resolveTypesafeDriver(options(), failingImport).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DecisionConfigError);
        expect((error as DecisionConfigError).variable).toBe('TYPESAFE_BACKEND');
        expect((error as Error).message).toContain("requires '@gobing-ai/ts-ai-decision' to be installed");
        expect((error as Error).message).toContain('bun add @gobing-ai/ts-ai-decision');
        expect((error as { cause?: unknown }).cause).toBeInstanceOf(Error);
    });

    it('c. a module without createTypesafeDriver maps to TYPESAFE_BACKEND', async () => {
        const error = await resolveTypesafeDriver(options(), async () => ({})).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DecisionConfigError);
        expect((error as DecisionConfigError).variable).toBe('TYPESAFE_BACKEND');
        expect((error as Error).message).toContain(
            "Module '@gobing-ai/ts-ai-decision' does not export createTypesafeDriver",
        );
    });

    it('d. a missing key fails before any import is attempted', async () => {
        let imports = 0;
        const error = await resolveTypesafeDriver({ env: {} }, async () => {
            imports += 1;
            return {};
        }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DecisionConfigError);
        expect((error as DecisionConfigError).variable).toBe('TYPESAFE_API_KEY');
        expect((error as Error).message).toContain('Missing TYPESAFE_API_KEY');
        expect(imports).toBe(0);
    });

    it('construction errors propagate unchanged (no install hint)', async () => {
        // A non-constructible baseURL makes the SDK client constructor throw.
        const error = await resolveTypesafeDriver(options({ baseURL: 'not-a-url' }), async () => ({
            createTypesafeDriver: () => {
                throw new Error('bad baseURL');
            },
        })).catch((e: unknown) => e);
        expect((error as Error).message).toBe('bad baseURL');
        expect((error as Error).message).not.toContain('bun add');
    });

    it('resolveApiKey is exported and keeps its precedence', () => {
        expect(resolveApiKey({ apiKey: 'explicit', env: { TYPESAFE_API_KEY: 'from-env' } })).toBe('explicit');
        expect(resolveApiKey({ env: { TYPESAFE_API_KEY: 'from-env' } })).toBe('from-env');
    });
});
