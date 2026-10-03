import { describe, expect, test } from 'bun:test';
import { DecisionCatalogError, DecisionInputError } from '../src';

describe('DecisionCatalogError', () => {
    test('is an Error named DecisionCatalogError carrying source and optional location', () => {
        const error = new DecisionCatalogError('bad fallback', 'catalogs/support.yaml', 'category', 'fallback');
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('DecisionCatalogError');
        expect(error.message).toBe('bad fallback');
        expect(error.source).toBe('catalogs/support.yaml');
        expect(error.decisionId).toBe('category');
        expect(error.field).toBe('fallback');
    });

    test('decisionId and field are optional', () => {
        const error = new DecisionCatalogError('unresolvable $schema', 'inline.yaml');
        expect(error.decisionId).toBeUndefined();
        expect(error.field).toBeUndefined();
    });
});

describe('DecisionInputError', () => {
    test('is an Error named DecisionInputError carrying decisionId and param', () => {
        const error = new DecisionInputError('expects one of [p1, p2], got "p9"', 'ship_it', 'priority');
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('DecisionInputError');
        expect(error.decisionId).toBe('ship_it');
        expect(error.param).toBe('priority');
    });
});
