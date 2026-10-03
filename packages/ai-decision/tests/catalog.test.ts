import { describe, expect, test } from 'bun:test';
import type { Json } from '@gobing-ai/ts-ai-runner';
import { joinPath } from '@gobing-ai/ts-runtime';
import {
    buildState,
    type CatalogLoadOptions,
    DEFAULT_INSTRUCTIONS_TEMPLATE,
    type DecisionCatalog,
    DecisionCatalogError,
    type DecisionDefinition,
    DecisionInputError,
    loadDecisionCatalog,
    parseDecisionCatalog,
    renderQuestion,
    resolveDecisionInput,
} from '../src';

const fixture = (...segments: string[]) => joinPath(import.meta.dir, 'fixtures', ...segments);

/** Fetch a decision that must exist, failing the test with a clear name otherwise. */
function decisionOf(catalog: DecisionCatalog, id: string): DecisionDefinition {
    const decision = catalog.decisions[id];
    if (decision === undefined) throw new Error(`catalog "${catalog.source}" has no decision "${id}"`);
    return decision;
}

/** Load a fixture expected to fail; return the DecisionCatalogError for field/decision assertions. */
async function catalogFailure(path: string, options?: CatalogLoadOptions): Promise<DecisionCatalogError> {
    try {
        await loadDecisionCatalog(path, options);
    } catch (error) {
        expect(error).toBeInstanceOf(DecisionCatalogError);
        return error as DecisionCatalogError;
    }
    throw new Error(`expected "${path}" to fail loading, but it loaded`);
}

describe('loadDecisionCatalog (AC1: typed definitions)', () => {
    test('loads a multi-decision catalog with defaults and per-decision fields', async () => {
        const catalog = await loadDecisionCatalog(fixture('valid', 'catalog.yaml'));
        expect(catalog.defaults).toEqual({ maker: 'typesafe', model: 'jev-latest', minConfidence: 0.7 });
        expect(Object.keys(catalog.decisions).sort()).toEqual([
            'bug_severity',
            'category',
            'refund_requested',
            'send_reply',
        ]);
        expect(catalog.decisions.category?.source.endsWith('catalog.yaml')).toBe(true);

        const category = decisionOf(catalog, 'category');
        expect(category.type).toBe('choice');
        expect(category.fallback).toBe('account');
        expect(category.criteria).toEqual({
            kind: 'choice',
            labels: expect.objectContaining({ bug_report: expect.any(String), billing: expect.any(String) }),
        });

        const severity = decisionOf(catalog, 'bug_severity');
        expect(severity.type).toBe('score');
        expect(severity.maker).toBe('laya-local');
        expect(severity.fallback).toBe(1);
        expect(severity.criteria).toMatchObject({ kind: 'score' });
        if (severity.criteria.kind === 'score') expect(severity.criteria.levels).toHaveLength(3);

        const refund = decisionOf(catalog, 'refund_requested');
        expect(refund.type).toBe('noul');
        expect(refund.fallback).toBe(false);
        expect(refund.minConfidence).toBe(0.8);
        if (refund.criteria.kind === 'noul') {
            expect(refund.criteria.outcomes?.true).toBe('The customer explicitly asks for money back');
        }
    });

    test('adds the implicit reserved instructions parameter (string, default "")', async () => {
        const catalog = await loadDecisionCatalog(fixture('valid', 'catalog.yaml'));
        const category = decisionOf(catalog, 'category');
        expect(category.parameters.instructions).toEqual({
            name: 'instructions',
            type: 'string',
            required: false,
            default: '',
        });
        // Authored template passes through; absent template defaults to the caller-text passthrough.
        expect(category.instructions).toBe(`Classify this \${params.channel} ticket: \${params.instructions}`);
        expect(decisionOf(catalog, 'bug_severity').instructions).toBe(DEFAULT_INSTRUCTIONS_TEMPLATE);
        // Required means no default (shorthand); full form carries the default.
        expect(decisionOf(catalog, 'bug_severity').parameters.component?.required).toBe(true);
        expect(decisionOf(catalog, 'bug_severity').parameters.affected_users).toMatchObject({
            required: false,
            default: 10,
        });
    });

    test('loads the shipped example catalog end to end', async () => {
        const catalog = await loadDecisionCatalog(joinPath(import.meta.dir, '..', 'examples', 'support.yaml'));
        expect(catalog.decisions.send_reply?.fallback).toBe('discard');
    });
});

describe('loadDecisionCatalog (AC2: $schema handling)', () => {
    test('validates a catalog that declares the bundled schema', async () => {
        const catalog = await loadDecisionCatalog(fixture('valid', 'with-schema-ref.yaml'));
        expect(catalog.decisions.escalate?.fallback).toBe(false);
    });

    test('rejects an unresolvable $schema by default and honours validateSchema: false', async () => {
        const path = fixture('valid', 'with-unresolvable-schema.yaml');
        const error = await catalogFailure(path);
        expect(error.message).toMatch(/no-such-pkg/);

        const catalog = await loadDecisionCatalog(path, { validateSchema: false });
        expect(catalog.decisions.category?.fallback).toBe('a');
    });
});

describe('parseDecisionCatalog', () => {
    test('rejects sources that are not .yaml/.yml', async () => {
        const error = await catalogFailure(fixture('invalid', 'json-source.json'));
        expect(error.message).toMatch(/YAML only/);
        expect(error.source.endsWith('.json')).toBe(true);

        await expect(parseDecisionCatalog('version: 1\ndecisions: {}\n', 'catalog.json')).rejects.toThrow(
            DecisionCatalogError,
        );
    });

    test('rejects duplicate YAML keys', async () => {
        const error = await catalogFailure(fixture('invalid', 'duplicate-key.yaml'));
        expect(error.message).toMatch(/duplicat|unique/i);
    });

    test('rejects enum parameters without values and values on non-enum parameters', async () => {
        let error = await catalogFailureFixture(`version: 1
decisions:
  category:
    type: choice
    parameters:
      channel: { type: enum, default: email }
    criteria:
      a: First option
      b: Second option
    fallback: a
`);
        expect(error.decisionId).toBe('category');
        expect(error.field).toBe('parameters.channel.values');

        error = await catalogFailureFixture(`version: 1
decisions:
  category:
    type: choice
    parameters:
      channel: { type: string, values: [email], default: email }
    criteria:
      a: First option
      b: Second option
    fallback: a
`);
        expect(error.decisionId).toBe('category');
        expect(error.field).toBe('parameters.channel.values');
    });
});

/** Inline-content twin of {@link catalogFailure} for string-authored catalogs. */
async function catalogFailureFixture(content: string): Promise<DecisionCatalogError> {
    try {
        await parseDecisionCatalog(content, 'inline.yaml');
    } catch (error) {
        expect(error).toBeInstanceOf(DecisionCatalogError);
        return error as DecisionCatalogError;
    }
    throw new Error('expected inline catalog to fail loading, but it loaded');
}

/** Resolve a decision input expected to violate the parameter contract. */
function inputFailure(decision: DecisionDefinition, input: Record<string, Json>): DecisionInputError {
    try {
        resolveDecisionInput(decision, input);
    } catch (error) {
        expect(error).toBeInstanceOf(DecisionInputError);
        return error as DecisionInputError;
    }
    throw new Error(`expected input ${JSON.stringify(input)} to be rejected`);
}

describe('loadDecisionCatalog (AC4: inconsistent catalogs fail with decision and field named)', () => {
    test('schema violation', async () => {
        const error = await catalogFailure(fixture('invalid', 'schema-violation.yaml'));
        expect(error.message).toMatch(/extras/);
    });

    test('choice fallback outside the label vocabulary', async () => {
        const error = await catalogFailure(fixture('invalid', 'choice-fallback.yaml'));
        expect(error.decisionId).toBe('category');
        expect(error.field).toBe('fallback');
    });

    test('template ref to an undeclared parameter', async () => {
        const error = await catalogFailure(fixture('invalid', 'template-undeclared.yaml'));
        expect(error.decisionId).toBe('category');
        expect(error.field).toBe('instructions');
        expect(error.message).toMatch(/params\.topic/);
    });

    test('template ref outside the params namespace', async () => {
        const error = await catalogFailure(fixture('invalid', 'template-env.yaml'));
        expect(error.decisionId).toBe('category');
        expect(error.field).toBe('instructions');
        expect(error.message).toMatch(/env/);
    });

    test('declared reserved instructions parameter', async () => {
        const error = await catalogFailure(fixture('invalid', 'declared-instructions.yaml'));
        expect(error.decisionId).toBe('category');
        expect(error.field).toBe('parameters.instructions');
    });

    test('default that does not match its declared type', async () => {
        const error = await catalogFailure(fixture('invalid', 'default-type.yaml'));
        expect(error.decisionId).toBe('severity');
        expect(error.field).toBe('parameters.affected_users.default');
    });

    test('score fallback outside the rubric levels', async () => {
        const error = await catalogFailure(fixture('invalid', 'score-fallback.yaml'));
        expect(error.decisionId).toBe('severity');
        expect(error.field).toBe('fallback');
    });

    test('missing criteria for choice and score types', async () => {
        let error = await catalogFailureFixture(`version: 1
decisions:
  category:
    type: choice
    fallback: a
`);
        expect(error.decisionId).toBe('category');
        expect(error.field).toBe('criteria');

        error = await catalogFailureFixture(`version: 1
decisions:
  severity:
    type: score
    criteria:
      - Only one level
    fallback: 0
`);
        expect(error.decisionId).toBe('severity');
        expect(error.field).toBe('criteria');
    });
});

describe('loadDecisionCatalog (unreadable sources and raw-schema violations)', () => {
    test('wraps read failures with the source path', async () => {
        const path = fixture('valid', 'nope.yaml');
        const error = await catalogFailure(path);
        expect(error.message).toMatch(/Cannot read decision catalog/);
        expect(error.source).toBe(path);
    });

    test('names the decision and field from the zod issue path', async () => {
        const empty = await catalogFailureFixture('version: 1\ndecisions: {}\n');
        expect(empty.message).toMatch(/decisions must declare at least one decision/);
        expect(empty.field).toBeUndefined();
        expect(empty.decisionId).toBeUndefined();

        const badId = await catalogFailureFixture(`version: 1
decisions:
  Bad_Id:
    type: choice
    fallback: a
    criteria:
      a: First
      b: Second
`);
        expect(badId.decisionId).toBe('Bad_Id');
        expect(badId.field).toBe('decisions.Bad_Id');
    });

    test('validates defaults of every parameter type at load time', async () => {
        const catalog = await parseDecisionCatalog(
            `version: 1
decisions:
  ship_it:
    type: choice
    parameters:
      mode: { type: string, default: fast }
      flag: { type: boolean, default: false }
      effort: { type: number, default: 2 }
      level: { type: enum, values: [low, high], default: low }
      meta: { type: json, default: { a: 1 } }
    criteria:
      yes: Proceed
      no: Hold
    fallback: no
`,
            'inline.yaml',
        );
        const ship = catalog.decisions.ship_it;
        if (ship === undefined) throw new Error('ship_it decision missing');
        expect(resolveDecisionInput(ship, {})).toEqual({
            instructions: '',
            mode: 'fast',
            flag: false,
            effort: 2,
            level: 'low',
            meta: { a: 1 },
        });
    });

    test('choice criteria with a single label is rejected', async () => {
        const error = await catalogFailureFixture(`version: 1
decisions:
  category:
    type: choice
    criteria:
      only: One option
    fallback: only
`);
        expect(error.decisionId).toBe('category');
        expect(error.field).toBe('criteria');
        expect(error.message).toMatch(/at least two labels/);
    });

    test('choice fallback naming an inherited Object.prototype key is rejected as an undeclared label', async () => {
        const error = await catalogFailureFixture(`version: 1
decisions:
  category:
    type: choice
    criteria:
      yes: Proceed
      no: Hold
    fallback: constructor
`);
        expect(error.decisionId).toBe('category');
        expect(error.field).toBe('fallback');
        expect(error.message).toMatch(/is not a declared criteria label/);
    });

    test('score criteria must be a list of at least two levels', async () => {
        let error = await catalogFailureFixture(`version: 1
decisions:
  severity:
    type: score
    criteria:
      low: Mild
    fallback: 0
`);
        expect(error.message).toMatch(/must be a list/);

        error = await catalogFailureFixture(`version: 1
decisions:
  severity:
    type: score
    criteria:
      - Only one level
    fallback: 0
`);
        expect(error.message).toMatch(/at least two levels/);
    });

    test('noul criteria must be an object with only true/false keys and a boolean fallback', async () => {
        let error = await catalogFailureFixture(`version: 1
decisions:
  refund:
    type: noul
    criteria:
      - Not an object
    fallback: false
`);
        expect(error.message).toMatch(/must be an object/);

        error = await catalogFailureFixture(`version: 1
decisions:
  refund:
    type: noul
    criteria:
      true: Asked
      maybe: Unclear
    fallback: false
`);
        expect(error.message).toMatch(/only the keys "true" and "false"/);

        error = await catalogFailureFixture(`version: 1
decisions:
  refund:
    type: noul
    criteria:
      true: Asked
    fallback: 'nope'
`);
        expect(error.field).toBe('fallback');
        expect(error.message).toMatch(/noul fallback must be a boolean/);
    });

    test('template validation walks refs nested in JSON arrays and objects', async () => {
        const error = await catalogFailureFixture(`version: 1
decisions:
  category:
    type: choice
    criteria:
      a:
        - Broken \${params.thing}
        - text: Also \${params.thing}
      b: Fine
    fallback: a
`);
        expect(error.decisionId).toBe('category');
        expect(error.message).toMatch(/params\.thing/);
    });
});

describe('resolveDecisionInput (AC3: params shape the input)', () => {
    test('fills declared defaults plus the implicit instructions', async () => {
        const catalog = await loadDecisionCatalog(fixture('valid', 'catalog.yaml'));
        const category = decisionOf(catalog, 'category');
        expect(resolveDecisionInput(category, {})).toEqual({ channel: 'email', instructions: '' });
        expect(resolveDecisionInput(category, { instructions: 'ticket text' })).toEqual({
            channel: 'email',
            instructions: 'ticket text',
        });
    });

    test('rejects unknown keys, missing required params and type mismatches', async () => {
        const catalog = await loadDecisionCatalog(fixture('valid', 'catalog.yaml'));
        const severity = decisionOf(catalog, 'bug_severity');

        const unknown = inputFailure(severity, { component: 'api', channel: 'chat' });
        expect(unknown.param).toBe('channel');
        expect(unknown.decisionId).toBe('bug_severity');

        expect(inputFailure(severity, {}).param).toBe('component');
        expect(inputFailure(severity, { component: 'api', affected_users: 'ten' }).param).toBe('affected_users');
        // Enum values constrain the input even for a decision whose channel param has a default.
        const category = decisionOf(catalog, 'category');
        expect(inputFailure(category, { channel: 'fax' }).param).toBe('channel');
    });

    test('buildState excludes instructions and nulls, and is null when empty', async () => {
        const catalog = await loadDecisionCatalog(fixture('valid', 'catalog.yaml'));
        const category = decisionOf(catalog, 'category');
        const sendReply = decisionOf(catalog, 'send_reply');
        const refund = decisionOf(catalog, 'refund_requested');

        expect(buildState(category, resolveDecisionInput(category, {}))).toEqual({ channel: 'email' });
        // context default is null -> excluded; tone default kept; instructions excluded.
        expect(buildState(sendReply, resolveDecisionInput(sendReply, {}))).toEqual({ tone: 'casual' });
        // No declared parameters at all -> null.
        expect(buildState(refund, resolveDecisionInput(refund, { instructions: 'text' }))).toBeNull();
    });
});

describe('renderQuestion (R7: params.* rendering)', () => {
    test('renders instructions and criteria string leaves; labels stay static', async () => {
        const catalog = await loadDecisionCatalog(fixture('valid', 'catalog.yaml'));
        const category = decisionOf(catalog, 'category');
        const question = renderQuestion(
            category,
            resolveDecisionInput(category, { channel: 'chat', instructions: 'T' }),
        );
        expect(question.type).toBe('choice');
        expect(question).toMatchObject({
            instructions: 'Classify this chat ticket: T',
            criteria: { bug_report: 'The user is reporting something that is broken or producing errors' },
        });
    });

    test('defaults to the caller text passthrough and renders rubric levels', async () => {
        const catalog = await loadDecisionCatalog(fixture('valid', 'catalog.yaml'));
        const severity = decisionOf(catalog, 'bug_severity');
        const question = renderQuestion(severity, resolveDecisionInput(severity, { component: 'api' }));
        expect(question.type).toBe('score');
        expect(question.instructions).toBe('');
        if (question.type === 'score') {
            expect(question.criteria[1]).toBe('Broken or degraded feature in api; workaround exists');
        }
    });

    test('substitutes numbers, booleans, json and null per the design rules', async () => {
        const catalog = await loadDecisionCatalog(fixture('valid', 'catalog.yaml'));
        const sendReply = decisionOf(catalog, 'send_reply');

        const withJson = renderQuestion(
            sendReply,
            resolveDecisionInput(sendReply, { tone: 'formal', context: { ticket: 42 } }),
        );
        expect(withJson.instructions).toBe('Reply in a formal tone. Context: {"ticket":42}');

        const withNull = renderQuestion(sendReply, resolveDecisionInput(sendReply, { tone: 'formal' }));
        expect(withNull.instructions).toBe('Reply in a formal tone. Context: ');

        const refund = decisionOf(catalog, 'refund_requested');
        const noulQuestion = renderQuestion(refund, resolveDecisionInput(refund, { instructions: 'refund?' }));
        expect(noulQuestion.type).toBe('noul');
        expect(noulQuestion).toMatchObject({
            instructions: 'refund?',
            criteria: { true: 'The customer explicitly asks for money back', false: 'Anything else' },
        });
    });
});
