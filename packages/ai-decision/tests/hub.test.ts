import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
    type Answer,
    createDecisionMaker,
    type DecisionDriver,
    type DecisionState,
    DecisionTimeoutError,
    type Json,
    type Question,
} from '@gobing-ai/ts-ai-runner';
import { joinPath } from '@gobing-ai/ts-runtime';
import {
    createDecisionHub,
    type DecideOptions,
    DecisionCatalogError,
    DecisionHub,
    DecisionInputError,
    DecisionMakerRegistry,
    type DecisionResult,
    parseDecisionCatalog,
    UnknownDecisionError,
    UnknownDecisionMakerError,
} from '../src';

const EXAMPLES_PATH = joinPath(import.meta.dir, '..', 'examples', 'decisions.yaml');
const OUTPUT_DIR = joinPath(import.meta.dir, 'output');

/** The repeatable e2e artifact: every decide result of this suite, in run order. */
const transcript: Array<{ case: string } & DecisionResult> = [];

afterAll(() => {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(
        joinPath(OUTPUT_DIR, 'hub-e2e-transcript.json'),
        `${JSON.stringify({ suite: 'hub-e2e', results: transcript }, null, 2)}\n`,
    );
});

interface AskRequest {
    state: DecisionState;
    questions: Record<string, Question>;
    model?: string;
}

/**
 * Scripted DecisionDriver: records every ask request so the suite can assert
 * the exact question map, state and model the hub sent, and answers from a
 * per-test script. Registered into the hub's registry BY NAME.
 */
class ScriptedDriver implements DecisionDriver {
    readonly name: string;
    readonly requests: AskRequest[] = [];
    respond: (req: AskRequest) => Record<string, Answer> = () => ({});

    constructor(name: string) {
        this.name = name;
    }

    ask(req: AskRequest): Promise<Record<string, Answer>> {
        this.requests.push(req);
        return Promise.resolve(this.respond(req));
    }
}

/** Hub over scripted drivers registered by name; deterministic clock so durationMs is stable. */
function makeHub(drivers: ScriptedDriver[], options: { defaultMaker?: string } = {}): DecisionHub {
    const registry = new DecisionMakerRegistry({ builtins: false });
    for (const driver of drivers) registry.register(driver.name, () => createDecisionMaker({ driver }));
    return new DecisionHub({
        registry,
        defaultMaker: options.defaultMaker ?? drivers[0]?.name,
        now: () => 0,
    });
}

/** Hub with the two maker names examples/decisions.yaml names: typesafe (default) and laya-local. */
async function examplesHub(): Promise<{ hub: DecisionHub; typesafe: ScriptedDriver; laya: ScriptedDriver }> {
    const typesafe = new ScriptedDriver('typesafe');
    const laya = new ScriptedDriver('laya-local');
    const hub = makeHub([typesafe, laya]);
    await hub.loadFile(EXAMPLES_PATH);
    return { hub, typesafe, laya };
}

/** Load an inline YAML catalog into the hub (bypasses the filesystem; source must still be .yaml). */
async function loadInline(hub: DecisionHub, yaml: string, source = 'inline.yaml'): Promise<void> {
    hub.load(await parseDecisionCatalog(yaml, source));
}

/** Run decide and record the result in the transcript artifact. */
async function decideAndRecord(
    name: string,
    hub: DecisionHub,
    id: string,
    input?: Record<string, Json>,
    options?: DecideOptions,
): Promise<DecisionResult> {
    const result = await hub.decide(id, input, options);
    transcript.push({ case: name, ...result });
    return result;
}

/** The single recorded request of a driver, failing loudly when the hub called it not exactly once. */
function singleRequest(driver: ScriptedDriver): AskRequest {
    if (driver.requests.length !== 1) {
        throw new Error(`driver "${driver.name}" recorded ${driver.requests.length} requests, expected exactly 1`);
    }
    return driver.requests[0] as AskRequest;
}

function choiceAnswer(
    id: string,
    label: string,
    confidence: number,
    labels: readonly string[],
): Record<string, Answer> {
    const others = (1 - confidence) / Math.max(labels.length - 1, 1);
    return {
        [id]: {
            kind: 'choice',
            label,
            confidence,
            probabilities: Object.fromEntries(labels.map((name) => [name, name === label ? confidence : others])),
        },
    };
}

function scoreAnswer(id: string, score: number, confidence: number, levels: number): Record<string, Answer> {
    const indices = Array.from({ length: levels }, (_, i) => i);
    return {
        [id]: {
            kind: 'score',
            score,
            confidence,
            legend: Object.fromEntries(indices.map((i) => [i, `level ${i}`])),
            probabilities: Object.fromEntries(
                indices.map((i) => [i, i === Math.round(score) ? confidence : (1 - confidence) / (levels - 1)]),
            ),
        },
    };
}

function noulAnswer(id: string, probability: number): Record<string, Answer> {
    return { [id]: { kind: 'noul', probability } };
}

/** Capture an expected rejection (decide or load) and return the error for field assertions. */
async function failureOf(promise: Promise<unknown>): Promise<Error> {
    return promise.then(
        () => {
            throw new Error('expected the call to reject');
        },
        (error: unknown) => {
            expect(error).toBeInstanceOf(Error);
            return error as Error;
        },
    );
}

describe('DecisionHub load and discovery (AC1/AC2)', () => {
    test('loads examples/decisions.yaml, lists summaries and describes the served contract', async () => {
        const { hub } = await examplesHub();
        expect(hub.list().map((d) => d.id)).toEqual(['category', 'bug_severity', 'refund_requested']);
        expect(hub.list()[0]).toEqual({
            id: 'category',
            type: 'choice',
            description: 'Route an inbound support ticket',
            source: EXAMPLES_PATH,
        });
        expect(hub.list()[1]).toEqual({ id: 'bug_severity', type: 'score', source: EXAMPLES_PATH });

        const category = hub.describe('category');
        expect(category.minConfidence).toBe(0.7); // catalog defaults floor
        expect(category.maker).toBe('typesafe'); // catalog defaults maker
        expect(category.model).toBe('jev-latest');
        expect(category.fallback).toBe('account');
        expect(category.parameters.instructions).toEqual({
            name: 'instructions',
            type: 'string',
            required: false,
            default: '',
        });
        expect(category.parameters.channel).toMatchObject({
            type: 'enum',
            values: ['email', 'chat'],
            default: 'email',
        });

        // Effective overrides: decision-level floor and maker win over catalog defaults.
        expect(hub.describe('refund_requested').minConfidence).toBe(0.8);
        expect(hub.describe('bug_severity').maker).toBe('laya-local');
    });

    test('rejects a duplicate decision id across catalogs, naming both sources, and registers nothing', async () => {
        const { hub } = await examplesHub();
        const error = await failureOf(
            loadInline(
                hub,
                `version: 1
decisions:
  brand_new:
    type: choice
    criteria: { a: First, b: Second }
    fallback: a
  category:
    type: choice
    criteria: { a: First, b: Second }
    fallback: a
`,
                'duplicate.yaml',
            ),
        );
        expect(error).toBeInstanceOf(DecisionCatalogError);
        const duplicate = error as DecisionCatalogError;
        expect(duplicate.message).toContain('duplicate.yaml');
        expect(duplicate.message).toContain(EXAMPLES_PATH);
        expect(duplicate.decisionId).toBe('category');
        expect(duplicate.source).toBe('duplicate.yaml');
        // All-or-nothing: brand_new was in the offending catalog and must not be registered either.
        expect(hub.list().map((d) => d.id)).toEqual(['category', 'bug_severity', 'refund_requested']);
    });

    test('rejects a decision naming an unregistered maker (field maker) and registers nothing', async () => {
        const { hub } = await examplesHub();
        const error = await failureOf(
            loadInline(
                hub,
                `version: 1
decisions:
  ok_choice:
    type: choice
    criteria: { a: First, b: Second }
    fallback: a
  bad_maker:
    type: choice
    maker: missing-maker
    criteria: { a: First, b: Second }
    fallback: a
`,
            ),
        );
        expect(error).toBeInstanceOf(DecisionCatalogError);
        const catalogError = error as DecisionCatalogError;
        expect(catalogError.field).toBe('maker');
        expect(catalogError.decisionId).toBe('bad_maker');
        expect(hub.list().map((d) => d.id)).not.toContain('ok_choice');
    });

    test('rejects unregistered defaults.maker for the whole catalog (field maker)', async () => {
        const { hub } = await examplesHub();
        const error = await failureOf(
            loadInline(
                hub,
                `version: 1
defaults:
  maker: missing-default
decisions:
  ok_choice:
    type: choice
    criteria: { a: First, b: Second }
    fallback: a
`,
            ),
        );
        expect(error).toBeInstanceOf(DecisionCatalogError);
        const catalogError = error as DecisionCatalogError;
        expect(catalogError.field).toBe('maker');
        expect(catalogError.decisionId).toBeUndefined();
        expect(hub.list().map((d) => d.id)).toEqual(['category', 'bug_severity', 'refund_requested']);
    });
});

describe('DecisionHub caller errors (AC7/AC10) — named errors before any backend call', () => {
    test('unknown id throws UnknownDecisionError from decide and describe without touching a maker', async () => {
        const { hub, typesafe, laya } = await examplesHub();
        const error = await failureOf(hub.decide('nope', { instructions: 'x' }));
        expect(error).toBeInstanceOf(UnknownDecisionError);
        expect((error as UnknownDecisionError).decisionId).toBe('nope');
        expect(() => hub.describe('nope')).toThrow(UnknownDecisionError);
        expect(typesafe.requests).toHaveLength(0);
        expect(laya.requests).toHaveLength(0);
    });

    test('invalid input throws DecisionInputError before any backend call', async () => {
        const { hub, typesafe, laya } = await examplesHub();
        const missing = await failureOf(hub.decide('bug_severity', {}));
        expect(missing).toBeInstanceOf(DecisionInputError);
        expect((missing as DecisionInputError).param).toBe('component');

        const unknown = await failureOf(hub.decide('category', { instructions: 'x', channel: 'fax' }));
        expect((unknown as DecisionInputError).param).toBe('channel');
        expect(typesafe.requests).toHaveLength(0);
        expect(laya.requests).toHaveLength(0);
    });

    test('unregistered per-call maker throws UnknownDecisionMakerError before any backend call', async () => {
        const { hub, typesafe, laya } = await examplesHub();
        const error = await failureOf(hub.decide('category', { instructions: 'x' }, { maker: 'nope' }));
        expect(error).toBeInstanceOf(UnknownDecisionMakerError);
        expect((error as UnknownDecisionMakerError).name).toBe('nope');
        expect(typesafe.requests).toHaveLength(0);
        expect(laya.requests).toHaveLength(0);
    });

    test('constructor throws UnknownDecisionMakerError for an unregistered defaultMaker', () => {
        const registry = new DecisionMakerRegistry({ builtins: false });
        expect(() => new DecisionHub({ registry, defaultMaker: 'absent' })).toThrow(UnknownDecisionMakerError);
    });
});

describe('DecisionHub.decide happy paths (AC3/AC4/AC8/AC9)', () => {
    test('sends exactly one substituted Jev question with state and model, and returns the answer', async () => {
        const { hub, typesafe, laya } = await examplesHub();
        typesafe.respond = () =>
            choiceAnswer('category', 'billing', 0.9, ['bug_report', 'billing', 'feature_request', 'account']);

        const result = await decideAndRecord('choice accepted', hub, 'category', {
            instructions: 'Cannot log in',
            channel: 'chat',
        });

        const asked = singleRequest(typesafe);
        expect(laya.requests).toHaveLength(0); // exactly one maker driven
        expect(asked.questions.category).toEqual({
            kind: 'choice',
            prompt: 'Classify this chat ticket: Cannot log in', // ${params.*} substituted into instructions
            labels: {
                bug_report: 'The user is reporting something that is broken or producing errors',
                billing: 'Charges, invoices, refunds, subscriptions',
                feature_request: 'The user is requesting new functionality',
                account: 'Login, permissions, profile, security',
            },
        });
        expect(asked.state).toEqual({ channel: 'chat' }); // declared params only; instructions and nulls excluded
        expect(asked.model).toBe('jev-latest'); // catalog defaults.model forwarded

        expect(result).toEqual({
            id: 'category',
            type: 'choice',
            value: 'billing',
            confidence: 0.9,
            source: 'model',
            reason: 'accepted',
            maker: 'typesafe',
            durationMs: 0,
        });
    });

    test('every maker-precedence step: per-call > decision > catalog defaults > hub defaultMaker', async () => {
        const perCall = new ScriptedDriver('maker-percall');
        const catalogLevel = new ScriptedDriver('maker-catalog');
        const decisionLevel = new ScriptedDriver('maker-decision');
        const hubDefault = new ScriptedDriver('maker-default');
        const hub = makeHub([perCall, catalogLevel, decisionLevel, hubDefault], { defaultMaker: 'maker-default' });
        await loadInline(
            hub,
            `version: 1
defaults:
  maker: maker-catalog
decisions:
  plain_choice:
    type: choice
    criteria: { a: First, b: Second }
    fallback: a
  pinned_choice:
    type: choice
    maker: maker-decision
    criteria: { a: First, b: Second }
    fallback: b
`,
        );
        const answerFirst = (req: AskRequest) =>
            choiceAnswer(Object.keys(req.questions)[0] as string, 'a', 0.9, ['a', 'b']);
        perCall.respond = answerFirst;
        catalogLevel.respond = answerFirst;
        decisionLevel.respond = answerFirst;
        hubDefault.respond = answerFirst;

        // Catalog defaults.maker beats the hub defaultMaker.
        expect((await decideAndRecord('precedence: catalog defaults', hub, 'plain_choice')).maker).toBe(
            'maker-catalog',
        );
        // Decision maker beats catalog defaults.
        expect((await decideAndRecord('precedence: decision maker', hub, 'pinned_choice')).maker).toBe(
            'maker-decision',
        );
        // Per-call maker beats everything.
        expect(
            (await decideAndRecord('precedence: per-call maker', hub, 'pinned_choice', {}, { maker: 'maker-percall' }))
                .maker,
        ).toBe('maker-percall');
        expect(singleRequest(perCall).questions.pinned_choice).toBeDefined();
        expect(catalogLevel.requests).toHaveLength(1);
        expect(decisionLevel.requests).toHaveLength(1);
        expect(hubDefault.requests).toHaveLength(0); // the named levels all outranked the hub default

        // Hub defaultMaker used when neither the decision nor the catalog names a maker.
        const bare = makeHub([hubDefault]);
        await loadInline(
            bare,
            `version: 1
decisions:
  bare_choice:
    type: choice
    criteria: { a: First, b: Second }
    fallback: a
`,
        );
        expect((await decideAndRecord('precedence: hub defaultMaker', bare, 'bare_choice')).maker).toBe(
            'maker-default',
        );
    });

    test('model precedence: decision model wins over catalog defaults; omitted when neither declares one', async () => {
        const driver = new ScriptedDriver('model-check');
        driver.respond = (req) => choiceAnswer(Object.keys(req.questions)[0] as string, 'a', 0.9, ['a', 'b']);
        const hub = makeHub([driver]);
        await loadInline(
            hub,
            `version: 1
defaults:
  model: defaults-model
decisions:
  modeled:
    type: choice
    model: decision-model
    criteria: { a: First, b: Second }
    fallback: a
  unmodeled:
    type: choice
    criteria: { a: First, b: Second }
    fallback: a
`,
        );
        await decideAndRecord('model: decision wins', hub, 'modeled');
        expect(singleRequest(driver).model).toBe('decision-model');

        driver.requests.length = 0;
        await decideAndRecord('model: catalog default', hub, 'unmodeled');
        expect(singleRequest(driver).model).toBe('defaults-model');

        driver.requests.length = 0;
        await loadInline(
            hub,
            `version: 1
decisions:
  plain:
    type: choice
    criteria: { a: First, b: Second }
    fallback: a
`,
        );
        await decideAndRecord('model: omitted', hub, 'plain');
        expect('model' in singleRequest(driver)).toBe(false);
    });

    test('score decision: fractional expected score through the decision-level maker', async () => {
        const { hub, laya, typesafe } = await examplesHub();
        laya.respond = () => scoreAnswer('bug_severity', 1.5, 0.85, 3);

        const result = await decideAndRecord('score accepted', hub, 'bug_severity', { component: 'api' });
        const asked = singleRequest(laya);
        expect(typesafe.requests).toHaveLength(0); // decision.maker routed, defaults.maker not used
        expect(asked.questions.bug_severity).toEqual({
            kind: 'score',
            prompt: '', // no authored instructions -> caller text passthrough, empty input
            rubric: [
                'Cosmetic; no impact to functionality',
                'Broken or degraded feature in api; workaround exists', // ${params.component} substituted
                'Blocking issue; no workaround exists',
            ],
        });
        expect(asked.state).toEqual({ component: 'api', affected_users: 10 }); // declared default filled
        expect(result).toEqual({
            id: 'bug_severity',
            type: 'score',
            value: 1.5, // expected score may fall between levels
            confidence: 0.85,
            source: 'model',
            reason: 'accepted',
            maker: 'laya-local',
            durationMs: 0,
        });
    });

    test('noul decision: yes/no outcome mapping, null state, and the accepted path above the floor', async () => {
        const { hub, typesafe } = await examplesHub();
        typesafe.respond = () => noulAnswer('refund_requested', 0.9);
        const result = await decideAndRecord('noul accepted', hub, 'refund_requested', { instructions: 'refund?' });
        expect(singleRequest(typesafe).questions.refund_requested).toEqual({
            kind: 'noul',
            prompt: 'refund?',
            yes: 'The customer explicitly asks for money back', // criteria.true -> yes
            no: 'Anything else', // criteria.false -> no
        });
        expect(singleRequest(typesafe).state).toBeNull(); // refund declares no parameters -> null state
        expect(result).toEqual({
            id: 'refund_requested',
            type: 'noul',
            value: true,
            confidence: 0.9,
            source: 'model',
            reason: 'accepted', // 0.9 >= the declared 0.8 floor
            maker: 'typesafe',
            durationMs: 0,
            probability: 0.9,
        });
    });

    test('noul at the p >= 0.5 boundary with a floor the answer can meet', async () => {
        const driver = new ScriptedDriver('boundary');
        const hub = makeHub([driver]);
        await loadInline(
            hub,
            `version: 1
decisions:
  coin:
    type: noul
    minConfidence: 0.5
    fallback: false
`,
        );
        driver.respond = () => noulAnswer('coin', 0.5);
        const atHalf = await decideAndRecord('noul boundary at half', hub, 'coin');
        expect(atHalf).toEqual({
            id: 'coin',
            type: 'noul',
            value: true, // p >= 0.5
            confidence: 0.5, // max(p, 1-p)
            source: 'model',
            reason: 'accepted', // 0.5 meets the 0.5 floor exactly
            maker: 'boundary',
            durationMs: 0,
            probability: 0.5,
        });

        driver.respond = () => noulAnswer('coin', 0.45);
        const below = await decideAndRecord('noul boundary below half', hub, 'coin');
        expect(below).toEqual({
            id: 'coin',
            type: 'noul',
            value: false, // p < 0.5 flips the value even though confidence max(p,1-p) passes
            confidence: 0.55,
            source: 'model',
            reason: 'accepted',
            maker: 'boundary',
            durationMs: 0,
            probability: 0.45,
        });
    });
});

describe('DecisionHub.decide fallbacks (AC5/AC6) — never rejects for backend outcomes', () => {
    test('low-confidence choice returns the declared fallback with the observed confidence', async () => {
        const { hub, typesafe } = await examplesHub();
        typesafe.respond = () =>
            choiceAnswer('category', 'billing', 0.5, ['bug_report', 'billing', 'feature_request', 'account']);
        const result = await decideAndRecord('low-confidence choice', hub, 'category', { instructions: 'x' });
        expect(result).toEqual({
            id: 'category',
            type: 'choice',
            value: 'account', // declared fallback
            confidence: 0.5, // observed
            source: 'default',
            reason: 'low-confidence',
            maker: 'typesafe',
            durationMs: 0,
        });
    });

    test('noul below the declared floor returns the fallback with the observed probability', async () => {
        const { hub, typesafe } = await examplesHub();
        typesafe.respond = () => noulAnswer('refund_requested', 0.5);
        // p=0.5 gives confidence max(0.5, 0.5)=0.5, below the declared 0.8 floor: value flips to the fallback.
        const result = await decideAndRecord('low-confidence noul', hub, 'refund_requested', {
            instructions: 'maybe?',
        });
        expect(result).toEqual({
            id: 'refund_requested',
            type: 'noul',
            value: false,
            probability: 0.5,
            confidence: 0.5, // observed, below the floor
            source: 'default',
            reason: 'low-confidence',
            maker: 'typesafe',
            durationMs: 0,
        });
    });

    test('backend missing: a typesafe maker without a key resolves to no-backend (DecisionConfigError)', async () => {
        // Real composition path: the registry factory builds a keyless typesafe maker; the
        // DecisionConfigError surfaces from ask's lazy driver construction and maps to no-backend.
        const registry = new DecisionMakerRegistry({ builtins: false });
        registry.register('keyless', () => createDecisionMaker({ backend: 'typesafe', env: {} }));
        const hub = new DecisionHub({ registry, defaultMaker: 'keyless', now: () => 0 });
        await loadInline(
            hub,
            `version: 1
decisions:
  plain:
    type: choice
    criteria: { a: First, b: Second }
    fallback: a
`,
        );
        const result = await decideAndRecord('no-backend: missing key', hub, 'plain');
        expect(result).toEqual({
            id: 'plain',
            type: 'choice',
            value: 'a',
            confidence: null,
            source: 'default',
            reason: 'no-backend',
            maker: 'keyless',
            durationMs: 0,
        });
    });

    test('a factory that throws resolves to no-backend; a later resolve may retry', async () => {
        const registry = new DecisionMakerRegistry({ builtins: false });
        let fixed = false;
        registry.register('boom', () => {
            if (!fixed) throw new Error('driver construction failed');
            return createDecisionMaker({ driver: new ScriptedDriver('boom') });
        });
        const hub = new DecisionHub({ registry, defaultMaker: 'boom', now: () => 0 });
        await loadInline(
            hub,
            `version: 1
decisions:
  plain:
    type: choice
    criteria: { a: First, b: Second }
    fallback: b
`,
        );
        const failed = await decideAndRecord('no-backend: factory throws', hub, 'plain');
        expect(failed).toEqual({
            id: 'plain',
            type: 'choice',
            value: 'b',
            confidence: null,
            source: 'default',
            reason: 'no-backend',
            maker: 'boom',
            durationMs: 0,
        });

        fixed = true;
        expect((await registry.resolve('boom')).driver).toBe('boom'); // the failed factory was not memoised
    });

    test('timeout resolves to the declared fallback with reason timeout', async () => {
        const { hub, laya } = await examplesHub();
        laya.respond = () => {
            throw new DecisionTimeoutError('driver timed out', 5000);
        };
        const result = await decideAndRecord('timeout', hub, 'bug_severity', { component: 'api' });
        expect(result).toEqual({
            id: 'bug_severity',
            type: 'score',
            value: 1,
            confidence: null,
            source: 'default',
            reason: 'timeout',
            maker: 'laya-local',
            durationMs: 0,
        });
    });

    test('invalid and mismatched answers resolve to reason error', async () => {
        const { hub, typesafe } = await examplesHub();
        typesafe.respond = () => ({}); // missing answer for the question key
        const missing = await decideAndRecord('error: missing answer', hub, 'category', { instructions: 'x' });
        expect(missing).toEqual({
            id: 'category',
            type: 'choice',
            value: 'account',
            confidence: null,
            source: 'default',
            reason: 'error',
            maker: 'typesafe',
            durationMs: 0,
        });

        typesafe.requests.length = 0;
        typesafe.respond = () => noulAnswer('category', 0.9); // wrong answer kind for a choice question
        const wrongKind = await decideAndRecord('error: mismatched answer kind', hub, 'category', {
            instructions: 'x',
        });
        expect(wrongKind).toMatchObject({ type: 'choice', value: 'account', confidence: null, reason: 'error' });

        typesafe.requests.length = 0;
        const malformed = choiceAnswer('category', 'billing', 0.9, [
            'bug_report',
            'billing',
            'feature_request',
            'account',
        ]);
        const malformedAnswer = malformed.category;
        if (malformedAnswer?.kind !== 'choice') throw new Error('expected a choice answer');
        malformedAnswer.probabilities.bug_report = 0.5; // probability mass no longer sums to 1
        typesafe.respond = () => malformed;
        const badMass = await decideAndRecord('error: unnormalized answer mass', hub, 'category', {
            instructions: 'x',
        });
        expect(badMass).toMatchObject({
            type: 'choice',
            value: 'account',
            confidence: null,
            source: 'default',
            reason: 'error',
            maker: 'typesafe',
        });
        expect(typesafe.requests).toHaveLength(1);
    });

    test('unnormalized score mass selects the declared fallback after one request', async () => {
        const { hub, laya } = await examplesHub();
        const malformed = scoreAnswer('bug_severity', 1.5, 0.9, 3);
        const value = malformed.bug_severity;
        if (value?.kind !== 'score') throw new Error('expected score answer');
        value.probabilities = { 0: 0.2, 1: 0.2, 2: 0.1 };
        laya.respond = () => malformed;
        expect(await hub.decide('bug_severity', { component: 'api' })).toMatchObject({
            type: 'score',
            value: 1,
            confidence: null,
            source: 'default',
            reason: 'error',
            maker: 'laya-local',
        });
        expect(laya.requests).toHaveLength(1);
    });

    test('templates are always substituted and empty caller instructions render as empty text', async () => {
        const { hub, typesafe } = await examplesHub();
        typesafe.respond = () =>
            choiceAnswer('category', 'account', 0.9, ['bug_report', 'billing', 'feature_request', 'account']);
        await decideAndRecord('empty instructions', hub, 'category');
        const asked = singleRequest(typesafe);
        expect(asked.questions.category).toMatchObject({ kind: 'choice', prompt: 'Classify this email ticket: ' });
        expect(JSON.stringify(asked)).not.toContain('${params.'); // nothing unsubstituted reaches the wire
    });
});

describe('createDecisionHub (AC11) — one call to a ready hub', () => {
    test('builds over two catalog files with registered makers and serves decide end to end', async () => {
        const typesafe = new ScriptedDriver('typesafe');
        const laya = new ScriptedDriver('laya-local');
        const scorer = new ScriptedDriver('scorer');
        typesafe.respond = () =>
            choiceAnswer('category', 'bug_report', 0.9, ['bug_report', 'billing', 'feature_request', 'account']);
        scorer.respond = () => scoreAnswer('triage_priority', 1, 0.8, 2);

        const extraDir = mkdtempSync(joinPath(tmpdir(), 'hub-e2e-'));
        const extraCatalog = joinPath(extraDir, 'extra.yaml');
        writeFileSync(
            extraCatalog,
            `version: 1
decisions:
  triage_priority:
    type: score
    maker: scorer
    criteria:
      - Routine
      - Urgent
    fallback: 0
`,
        );

        const hub = await createDecisionHub({
            builtins: false,
            makers: {
                typesafe: () => createDecisionMaker({ driver: typesafe }),
                'laya-local': () => createDecisionMaker({ driver: laya }),
                scorer: () => createDecisionMaker({ driver: scorer }),
            },
            catalogs: [EXAMPLES_PATH, extraCatalog],
            now: () => 0,
        });

        expect(hub.list().map((d) => d.id)).toEqual([
            'category',
            'bug_severity',
            'refund_requested',
            'triage_priority',
        ]);
        const routed = await decideAndRecord('createDecisionHub: choice', hub, 'category', { instructions: 'crash' });
        expect(routed).toMatchObject({ value: 'bug_report', reason: 'accepted', maker: 'typesafe' });
        const scored = await decideAndRecord('createDecisionHub: score', hub, 'triage_priority', { instructions: 'x' });
        expect(scored).toMatchObject({ value: 1, reason: 'accepted', maker: 'scorer' });
        expect(singleRequest(scorer).questions.triage_priority).toMatchObject({
            kind: 'score',
            rubric: ['Routine', 'Urgent'],
        });
    });

    test('a bad catalog path rejects; no partially built hub is returned', async () => {
        const missingPath = joinPath(import.meta.dir, 'fixtures', 'valid', 'nope.yaml');
        await expect(
            createDecisionHub({
                builtins: false,
                makers: { typesafe: () => createDecisionMaker({ driver: new ScriptedDriver('typesafe') }) },
                catalogs: [missingPath],
            }),
        ).rejects.toThrow(DecisionCatalogError);

        // Second file bad: the first loads, the failure still rejects the whole call.
        await expect(
            createDecisionHub({
                builtins: false,
                makers: { typesafe: () => createDecisionMaker({ driver: new ScriptedDriver('typesafe') }) },
                catalogs: [EXAMPLES_PATH, missingPath],
            }),
        ).rejects.toThrow(DecisionCatalogError);
    });
});

describe('review-sensitivity additions — default floor and discovery purity', () => {
    test('applies the package-default floor 0.7 when neither decision nor defaults declare minConfidence', async () => {
        const driver = new ScriptedDriver('typesafe');
        const hub = makeHub([driver]);
        await loadInline(
            hub,
            `version: 1
decisions:
  bare:
    type: choice
    criteria: { a: First, b: Second }
    fallback: a
`,
        );
        driver.respond = () => choiceAnswer('bare', 'a', 0.65, ['a', 'b']);
        const result = await hub.decide('bare');
        expect(result.reason).toBe('low-confidence');
        expect(result.source).toBe('default');
        expect(result.value).toBe('a');
    });

    test('list() and describe() never run a maker factory', async () => {
        let factoryRuns = 0;
        const registry = new DecisionMakerRegistry({ builtins: false });
        registry.register('counted', () => {
            factoryRuns += 1;
            return createDecisionMaker({ driver: new ScriptedDriver('counted') });
        });
        const hub = new DecisionHub({ registry, defaultMaker: 'counted', now: () => 0 });
        await loadInline(
            hub,
            `version: 1
decisions:
  probed:
    type: choice
    maker: counted
    criteria: { a: First, b: Second }
    fallback: a
`,
        );
        expect(hub.list()).toHaveLength(1);
        expect(hub.describe('probed').maker).toBe('counted');
        expect(factoryRuns).toBe(0);
    });
});
