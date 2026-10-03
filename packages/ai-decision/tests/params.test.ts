import { describe, expect, test } from 'bun:test';
import {
    buildState,
    DEFAULT_INSTRUCTIONS_TEMPLATE,
    type DecisionDefinition,
    DecisionInputError,
    INSTRUCTIONS_PARAM,
    implicitInstructionsParam,
    renderQuestion,
    resolveDecisionInput,
} from '../src';

/** Hand-built decision exercising every declared parameter type (no YAML fixtures needed). */
function decision(overrides: Partial<DecisionDefinition> = {}): DecisionDefinition {
    return {
        id: 'ship_it',
        source: 'inline.yaml',
        type: 'choice',
        instructions: `Ship \${params.feature} now? Context: \${params.meta} Notes: \${params.instructions}`,
        parameters: {
            instructions: implicitInstructionsParam(),
            feature: { name: 'feature', type: 'string', required: true },
            priority: { name: 'priority', type: 'enum', required: false, default: 'p2', values: ['p1', 'p2'] },
            effort: { name: 'effort', type: 'number', required: false, default: 3 },
            flag: { name: 'flag', type: 'boolean', required: false, default: false },
            meta: { name: 'meta', type: 'json', required: false, default: null },
        },
        criteria: {
            kind: 'choice',
            labels: { yes: `Proceed with \${params.feature} at \${params.priority}`, no: null },
        },
        fallback: 'no',
        ...overrides,
    };
}

/** Resolve input expected to violate the parameter contract. */
function inputFailure(d: DecisionDefinition, input: Record<string, unknown>): DecisionInputError {
    try {
        resolveDecisionInput(d, input as never);
    } catch (error) {
        expect(error).toBeInstanceOf(DecisionInputError);
        return error as DecisionInputError;
    }
    throw new Error(`expected input ${JSON.stringify(input)} to be rejected`);
}

describe('implicitInstructionsParam / constants', () => {
    test('reserved param is a non-required string defaulting to ""', () => {
        expect(INSTRUCTIONS_PARAM).toBe('instructions');
        expect(DEFAULT_INSTRUCTIONS_TEMPLATE).toBe(`\${params.instructions}`);
        expect(implicitInstructionsParam()).toEqual({
            name: 'instructions',
            type: 'string',
            required: false,
            default: '',
        });
    });
});

describe('resolveDecisionInput', () => {
    test('overlays input on declared defaults and always carries instructions', () => {
        expect(resolveDecisionInput(decision(), { feature: 'login' })).toEqual({
            instructions: '',
            priority: 'p2',
            effort: 3,
            flag: false,
            meta: null,
            feature: 'login',
        });
    });

    test('rejects unknown keys, naming the offending key', () => {
        const error = inputFailure(decision(), { feature: 'x', urgency: 'now' });
        expect(error).toBeInstanceOf(DecisionInputError);
        expect(error.message).toMatch(/Unknown parameter "urgency"/);
        expect(error.param).toBe('urgency');
    });

    test('rejects input keys inherited from Object.prototype (constructor/valueOf)', () => {
        const constructorError = inputFailure(decision(), { feature: 'x', constructor: 'pwn' });
        expect(constructorError.message).toMatch(/Unknown parameter "constructor"/);
        expect(constructorError.param).toBe('constructor');
        expect(inputFailure(decision(), { feature: 'x', valueOf: 1 }).param).toBe('valueOf');
    });

    test('rejects missing required parameters (those without defaults)', () => {
        expect(inputFailure(decision(), {}).message).toMatch(/Missing required parameter "feature"/);
    });

    test('rejects type mismatches per declared type, including enum vocabulary and non-finite numbers', () => {
        expect(inputFailure(decision(), { feature: 7 }).message).toMatch(/expects string, got 7/);
        expect(inputFailure(decision(), { feature: 'x', priority: 'p9' }).message).toMatch(/one of \[p1, p2\]/);
        expect(inputFailure(decision(), { feature: 'x', effort: 'three' }).message).toMatch(/expects number/);
        expect(inputFailure(decision(), { feature: 'x', flag: 'yes' }).message).toMatch(/expects boolean/);
        expect(inputFailure(decision(), { feature: 'x', effort: Number.NaN }).message).toMatch(
            /expects number, got null/,
        );
    });

    test('accepts null as a provided value for json params and json params as any JSON value', () => {
        expect(resolveDecisionInput(decision(), { feature: 'x', meta: null }).meta).toBeNull();
        expect(resolveDecisionInput(decision(), { feature: 'x', meta: { ticket: 42 } }).meta).toEqual({ ticket: 42 });
    });
});

describe('renderQuestion substitution', () => {
    test('renders strings verbatim, numbers/booleans via String, json via JSON.stringify, null as ""', () => {
        const question = renderQuestion(decision(), resolveDecisionInput(decision(), { feature: 'login' }));
        expect(question).toMatchObject({
            instructions: 'Ship login now? Context:  Notes: ',
            criteria: { yes: 'Proceed with login at p2', no: null },
        });
        expect(
            renderQuestion(decision(), resolveDecisionInput(decision(), { feature: 'x', effort: 5, flag: true }))
                .instructions,
        ).toBe('Ship x now? Context:  Notes: ');

        const jsonDecision = decision({
            instructions: `n=\${params.effort} b=\${params.flag} j=\${params.meta} nul=\${params.meta}`,
        });
        expect(
            renderQuestion(jsonDecision, resolveDecisionInput(jsonDecision, { feature: 'x', meta: { a: [1, 'two'] } }))
                .instructions,
        ).toBe('n=3 b=false j={"a":[1,"two"]} nul={"a":[1,"two"]}');
    });

    test('renders refs nested in JSON-object and array Jev entries', () => {
        const structured = decision({
            instructions: {
                text: `Ship \${params.feature}`,
                tags: [`pri-\${params.priority}`, { deep: `\${params.flag}` }],
            },
        });
        expect(renderQuestion(structured, resolveDecisionInput(structured, { feature: 'login' })).instructions).toEqual(
            {
                text: 'Ship login',
                tags: ['pri-p2', { deep: 'false' }],
            },
        );
    });

    test('rejects template refs outside the params namespace', () => {
        const d = decision({ instructions: `leak \${env.HOME}` });
        try {
            renderQuestion(d, resolveDecisionInput(d, { feature: 'x' }));
            throw new Error('expected render to fail');
        } catch (error) {
            expect((error as Error).message).toMatch(/must use the "params" namespace/);
        }
    });

    test('renders noul outcomes and omits criteria when outcomes are undeclared', () => {
        const noul: DecisionDefinition = decision({
            type: 'noul',
            instructions: `Refund \${params.feature}?`,
            criteria: { kind: 'noul', outcomes: { true: 'Asked explicitly', false: null } },
            fallback: false,
        });
        expect(renderQuestion(noul, resolveDecisionInput(noul, { feature: 'x' }))).toEqual({
            type: 'noul',
            instructions: 'Refund x?',
            criteria: { true: 'Asked explicitly', false: null },
        });
        const bare = decision({
            type: 'noul',
            instructions: 'Go?',
            criteria: { kind: 'noul' },
            fallback: false,
        });
        expect(renderQuestion(bare, resolveDecisionInput(bare, { feature: 'x' }))).toEqual({
            type: 'noul',
            instructions: 'Go?',
        });
    });
});

describe('buildState', () => {
    test('keeps non-null declared values, drops instructions and nulls, null when nothing remains', () => {
        expect(buildState(decision(), resolveDecisionInput(decision(), { feature: 'login' }))).toEqual({
            priority: 'p2',
            effort: 3,
            flag: false,
            feature: 'login',
        });
        const state = buildState(decision(), resolveDecisionInput(decision(), { feature: 'x', meta: null }));
        expect(state).not.toBeNull();
        expect(state?.meta).toBeUndefined();
        const bare: DecisionDefinition = decision({
            instructions: 'Go?',
            parameters: { instructions: implicitInstructionsParam() },
            criteria: { kind: 'noul' },
            fallback: false,
        });
        expect(buildState(bare, resolveDecisionInput(bare, {}))).toBeNull();
    });
});
