import { describe, expect, test } from 'bun:test';
import { RULE_ENGINE_SCHEMA_SQL } from '../../src/persistence/schema';

describe('RULE_ENGINE_SCHEMA_SQL', () => {
    test('contains CREATE TABLE for rule_runs', () => {
        expect(RULE_ENGINE_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS rule_runs');
    });

    test('contains CREATE TABLE for rule_eval_runs', () => {
        expect(RULE_ENGINE_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS rule_eval_runs');
    });

    test('contains the FK reference from eval to runs', () => {
        expect(RULE_ENGINE_SCHEMA_SQL).toContain('REFERENCES rule_runs(id)');
    });

    test('contains the eval runs index', () => {
        expect(RULE_ENGINE_SCHEMA_SQL).toContain('CREATE INDEX IF NOT EXISTS idx_rule_eval_runs_run_id');
    });

    test('is a non-empty string', () => {
        expect(typeof RULE_ENGINE_SCHEMA_SQL).toBe('string');
        expect(RULE_ENGINE_SCHEMA_SQL.trim().length).toBeGreaterThan(0);
    });
});
