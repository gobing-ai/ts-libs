import { describe, expect, test } from 'bun:test';
import { BOOKKEEPING_HISTORY_TABLES, IMPORTER_OWNED_TABLES, SOURCE_DEFINITIONS, TYPED_HISTORY_TABLES } from '../src';

describe('IMPORTER_OWNED_TABLES (0749 R1)', () => {
    test('contains exactly the 15 importer-owned tables', () => {
        const expected = [
            'history_message',
            'history_tool_call',
            'history_skill_call',
            'history_import_checkpoint',
            'history_import_ledger',
            'history_etl_agy',
            'history_etl_antigravity',
            'history_etl_claude',
            'history_etl_codex',
            'history_etl_gemini',
            'history_etl_grok',
            'history_etl_omp',
            'history_etl_openclaw',
            'history_etl_opencode',
            'history_etl_pi',
        ];

        expect(IMPORTER_OWNED_TABLES.length).toBe(15);
        expect([...IMPORTER_OWNED_TABLES].sort()).toEqual([...expected].sort());
    });

    test('TYPED_HISTORY_TABLES contains the 3 typed contract tables', () => {
        expect([...TYPED_HISTORY_TABLES]).toEqual(['history_message', 'history_tool_call', 'history_skill_call']);
    });

    test('BOOKKEEPING_HISTORY_TABLES contains the 2 bookkeeping tables', () => {
        expect([...BOOKKEEPING_HISTORY_TABLES]).toEqual(['history_import_checkpoint', 'history_import_ledger']);
    });

    test('all SOURCE_DEFINITIONS target tables are included in IMPORTER_OWNED_TABLES', () => {
        for (const def of Object.values(SOURCE_DEFINITIONS)) {
            expect(IMPORTER_OWNED_TABLES).toContain(def.targetTable);
        }
    });
});
