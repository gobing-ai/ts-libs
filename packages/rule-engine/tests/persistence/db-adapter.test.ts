import { describe, expect, test } from 'bun:test';
import { createDbAdapter, type DbAdapter } from '@gobing-ai/ts-db';
import { DbRulePersistenceAdapter } from '../../src/persistence/db-adapter';
import { RULE_ENGINE_SCHEMA_SQL } from '../../src/persistence/schema';

async function execDdl(db: DbAdapter, sql: string): Promise<void> {
    for (const stmt of sql.split(';')) {
        const trimmed = stmt.trim();
        if (trimmed.length > 0) {
            await db.exec(`${trimmed};`);
        }
    }
}

async function freshDb(): Promise<DbAdapter> {
    const db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
    await execDdl(db, RULE_ENGINE_SCHEMA_SQL);
    return db;
}

describe('DbRulePersistenceAdapter', () => {
    test('insertRun writes a running row', async () => {
        const db = await freshDb();
        const adapter = new DbRulePersistenceAdapter(db);
        await adapter.insertRun({ id: 'r1', sourceKind: 'preset', ruleCount: 3, fixMode: 'none', dryRun: false });

        const run = await db.queryFirst<{ status: string; rule_count: number }>(
            'SELECT status, rule_count FROM rule_runs WHERE id = ?',
            'r1',
        );
        expect(run?.status).toBe('running');
        expect(run?.rule_count).toBe(3);
    });

    test('insertRun → updateRunStatus finalizes the row', async () => {
        const db = await freshDb();
        const adapter = new DbRulePersistenceAdapter(db);
        await adapter.insertRun({ id: 'r1', sourceKind: 'preset', ruleCount: 1, fixMode: 'none', dryRun: false });
        await adapter.updateRunStatus('r1', 'done', 5, 2, 2, 1000);

        const run = await db.queryFirst<{
            status: string;
            finding_count: number;
            fix_count: number;
            applied_fix_count: number;
            duration_ms: number;
        }>('SELECT status, finding_count, fix_count, applied_fix_count, duration_ms FROM rule_runs WHERE id = ?', 'r1');
        expect(run?.status).toBe('done');
        expect(run?.finding_count).toBe(5);
        expect(run?.fix_count).toBe(2);
        expect(run?.applied_fix_count).toBe(2);
        expect(run?.duration_ms).toBe(1000);
    });

    test('insertEvalRun → updateEvalRun lifecycle', async () => {
        const db = await freshDb();
        const adapter = new DbRulePersistenceAdapter(db);
        await db.run(
            `INSERT INTO rule_runs (id, source_kind, status, started_at, created_at, updated_at)
             VALUES ('r1', 'preset', 'running', datetime('now'), datetime('now'), datetime('now'))`,
        );
        await adapter.insertEvalRun({ id: 'e1', runId: 'r1', ruleId: 'no-x', severity: 'error', evaluator: 'rg' });
        await adapter.updateEvalRun({
            runId: 'r1',
            ruleId: 'no-x',
            status: 'done',
            findingCount: 0,
            fixCount: 0,
            durationMs: 42,
        });

        const evalRow = await db.queryFirst<{ status: string; duration_ms: number }>(
            'SELECT status, duration_ms FROM rule_eval_runs WHERE run_id = ? AND rule_id = ?',
            'r1',
            'no-x',
        );
        expect(evalRow?.status).toBe('done');
        expect(evalRow?.duration_ms).toBe(42);
    });
});
