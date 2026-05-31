import { describe, expect, test } from 'bun:test';
import { WORKFLOW_ENGINE_SCHEMA_SQL } from '../src/schema-sql';

describe('WORKFLOW_ENGINE_SCHEMA_SQL', () => {
    test('is a non-empty string', () => {
        expect(typeof WORKFLOW_ENGINE_SCHEMA_SQL).toBe('string');
        expect(WORKFLOW_ENGINE_SCHEMA_SQL.length).toBeGreaterThan(0);
    });

    test('contains CREATE TABLE statements', () => {
        expect(WORKFLOW_ENGINE_SCHEMA_SQL).toContain('CREATE TABLE');
    });

    test('includes runs table creation', () => {
        expect(WORKFLOW_ENGINE_SCHEMA_SQL).toInclude('runs');
    });

    test('includes phase_runs table creation', () => {
        expect(WORKFLOW_ENGINE_SCHEMA_SQL).toInclude('phase_runs');
    });

    test('includes transition_runs table creation', () => {
        expect(WORKFLOW_ENGINE_SCHEMA_SQL).toInclude('transition_runs');
    });

    test('includes workflow_states table creation', () => {
        expect(WORKFLOW_ENGINE_SCHEMA_SQL).toInclude('workflow_states');
    });

    test.each([
        ['runs'],
        ['phase_runs'],
        ['transition_runs'],
        ['workflow_states'],
    ])('CREATE TABLE IF NOT EXISTS %s', (table) => {
        expect(WORKFLOW_ENGINE_SCHEMA_SQL).toInclude(`CREATE TABLE IF NOT EXISTS ${table}`);
    });
});
