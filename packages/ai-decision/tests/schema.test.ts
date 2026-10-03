import { describe, expect, test } from 'bun:test';
import { DECISION_ID_PATTERN, DecisionCatalogSchema, MAKER_NAME_PATTERN, PARAM_NAME_PATTERN } from '../src';

/** Minimal valid catalog body every case below mutates. */
function catalog(overrides: Record<string, unknown> = {}, decision: Record<string, unknown> = {}) {
    return {
        version: 1,
        decisions: {
            ship_it: { type: 'choice', fallback: 'no', ...decision },
        },
        ...overrides,
    };
}

describe('DECISION_ID_PATTERN', () => {
    test('accepts kebab/snake lowercase ids and rejects leading digits, uppercase and hyphen-start', () => {
        expect('ship_it'.match(DECISION_ID_PATTERN)).not.toBeNull();
        expect('bug-severity-2'.match(DECISION_ID_PATTERN)).not.toBeNull();
        expect('2fast'.match(DECISION_ID_PATTERN)).toBeNull();
        expect('Ship_It'.match(DECISION_ID_PATTERN)).toBeNull();
        expect('_private'.match(DECISION_ID_PATTERN)).toBeNull();
    });
});

describe('PARAM_NAME_PATTERN / MAKER_NAME_PATTERN', () => {
    test('param names allow inner hyphen-free camelCase; maker names allow hyphens', () => {
        expect('affectedUsers'.match(PARAM_NAME_PATTERN)).not.toBeNull();
        expect('affected-users'.match(PARAM_NAME_PATTERN)).toBeNull();
        expect('laya-local'.match(MAKER_NAME_PATTERN)).not.toBeNull();
        expect('LayaLocal'.match(MAKER_NAME_PATTERN)).toBeNull();
    });
});

describe('DecisionCatalogSchema', () => {
    test('accepts a minimal one-decision catalog and a version-1 with defaults', () => {
        expect(DecisionCatalogSchema.safeParse(catalog()).success).toBeTrue();
        expect(
            DecisionCatalogSchema.safeParse(
                catalog({ defaults: { maker: 'typesafe', model: 'jev-latest', minConfidence: 0.7 } }),
            ).success,
        ).toBeTrue();
    });

    test('rejects an empty decisions map (refine) and a missing/incorrect version', () => {
        expect(DecisionCatalogSchema.safeParse({ version: 1, decisions: {} }).success).toBeFalse();
        expect(
            DecisionCatalogSchema.safeParse({ decisions: { ship_it: { type: 'choice', fallback: 'no' } } }).success,
        ).toBeFalse();
        expect(DecisionCatalogSchema.safeParse(catalog({ version: 2 })).success).toBeFalse();
    });

    test('is strict: unknown keys are rejected at catalog and decision level', () => {
        expect(DecisionCatalogSchema.safeParse(catalog({ extra: true })).success).toBeFalse();
        expect(DecisionCatalogSchema.safeParse(catalog({}, { typoKey: 'oops' })).success).toBeFalse();
    });

    test('rejects decision ids that violate DECISION_ID_PATTERN', () => {
        const bad = catalog();
        (bad.decisions as Record<string, unknown>).Ship_It = (bad.decisions as Record<string, unknown>).ship_it;
        delete (bad.decisions as Record<string, unknown>).ship_it;
        expect(DecisionCatalogSchema.safeParse(bad).success).toBeFalse();
    });

    test('rejects unknown decision types and out-of-range minConfidence', () => {
        expect(DecisionCatalogSchema.safeParse(catalog({}, { type: 'survey' })).success).toBeFalse();
        expect(DecisionCatalogSchema.safeParse(catalog({}, { minConfidence: 1.5 })).success).toBeFalse();
    });

    test('requires a primitive fallback (string, number or boolean)', () => {
        expect(DecisionCatalogSchema.safeParse(catalog({}, { fallback: { label: 'no' } })).success).toBeFalse();
        expect(DecisionCatalogSchema.safeParse(catalog({}, { fallback: null })).success).toBeFalse();
        expect(DecisionCatalogSchema.safeParse(catalog({}, { fallback: 3 })).success).toBeTrue();
        expect(DecisionCatalogSchema.safeParse(catalog({}, { fallback: false })).success).toBeTrue();
    });

    test('accepts the parameter shorthand (bare type string) and full form; rejects unknown keys in full form', () => {
        expect(
            DecisionCatalogSchema.safeParse(catalog({}, { parameters: { priority: 'enum', effort: 'number' } }))
                .success,
        ).toBeTrue();
        expect(
            DecisionCatalogSchema.safeParse(
                catalog(
                    {},
                    {
                        parameters: {
                            priority: { type: 'enum', values: ['p1', 'p2'], default: 'p2', description: 'urgency' },
                        },
                    },
                ),
            ).success,
        ).toBeTrue();
        expect(
            DecisionCatalogSchema.safeParse(catalog({}, { parameters: { priority: { type: 'enum', valuues: [] } } }))
                .success,
        ).toBeFalse();
    });

    test('rejects parameter names that violate PARAM_NAME_PATTERN', () => {
        expect(
            DecisionCatalogSchema.safeParse(catalog({}, { parameters: { 'affected-users': 'string' } })).success,
        ).toBeFalse();
    });

    test('accepts JSON-object/array/null Jev entries for instructions and criteria', () => {
        const structured = catalog(
            {},
            {
                instructions: { text: 'Ship it', tags: ['now', { depth: 2 }] },
                criteria: { a: null, b: ['x', { y: 1, z: null }] },
            },
        );
        expect(DecisionCatalogSchema.safeParse(structured).success).toBeTrue();
    });
});
