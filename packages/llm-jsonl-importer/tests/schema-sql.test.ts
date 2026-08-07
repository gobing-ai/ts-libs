import { describe, expect, test } from 'bun:test';
import { HISTORY_IMPORT_SCHEMA_SQL } from '../src/schema-sql';

describe('HISTORY_IMPORT_SCHEMA_SQL', () => {
    test('is a non-empty string containing CREATE TABLE', () => {
        expect(typeof HISTORY_IMPORT_SCHEMA_SQL).toBe('string');
        expect(HISTORY_IMPORT_SCHEMA_SQL.length).toBeGreaterThan(0);
        expect(HISTORY_IMPORT_SCHEMA_SQL).toContain('CREATE TABLE');
    });

    test('contains expected table names', () => {
        expect(HISTORY_IMPORT_SCHEMA_SQL).toMatch(/history_import_checkpoint/);
        expect(HISTORY_IMPORT_SCHEMA_SQL).toMatch(/history_import_ledger/);
        expect(HISTORY_IMPORT_SCHEMA_SQL).toMatch(/history_message/);
        expect(HISTORY_IMPORT_SCHEMA_SQL).toMatch(/history_tool_call/);
    });
});
