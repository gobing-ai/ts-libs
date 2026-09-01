import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDbAdapter, type DbAdapter } from '@gobing-ai/ts-db';
import { applyHistoryImportSchema, runOpenCodeImport } from '../src';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
        await rm(directory, { recursive: true, force: true });
    }
});

async function sourceDatabase(): Promise<{ db: DbAdapter; path: string }> {
    const directory = await mkdtemp(join(tmpdir(), 'opencode-importer-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'opencode.db');
    const db = await createDbAdapter({ driver: 'bun-sqlite', url: path });
    await db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL)');
    await db.exec(
        'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)',
    );
    await db.exec(
        'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)',
    );
    return { db, path };
}

describe('runOpenCodeImport', () => {
    test('imports SQLite messages and tools idempotently', async () => {
        const source = await sourceDatabase();
        const target = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        try {
            await source.db.run('INSERT INTO session (id, directory) VALUES (?, ?)', 'session-1', '/work/project');
            await source.db.run(
                'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
                'message-1',
                'session-1',
                1_700_000_000_000,
                JSON.stringify({
                    role: 'assistant',
                    time: { created: 1_700_000_000_000, completed: 1_700_000_000_500 },
                    modelID: 'gpt-5',
                    tokens: { input: 12, output: 5, cache: { read: 2, write: 1 } },
                    cost: 0.001,
                    path: { cwd: '/work/project' },
                }),
            );
            await source.db.run(
                'INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)',
                'part-text',
                'message-1',
                'session-1',
                1_700_000_000_001,
                JSON.stringify({ type: 'text', text: 'Done.' }),
            );
            await source.db.run(
                'INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)',
                'part-tool',
                'message-1',
                'session-1',
                1_700_000_000_002,
                JSON.stringify({
                    type: 'tool',
                    tool: 'bash',
                    state: {
                        status: 'completed',
                        input: { command: 'pwd' },
                        output: '/work/project',
                        time: { start: 1_700_000_000_100, end: 1_700_000_000_300 },
                    },
                }),
            );

            const first = await runOpenCodeImport({ db: target, sourceDatabase: source.path, mode: 'full' });
            expect(first.importedRecords).toBe(2);
            expect(first.parseErrors).toHaveLength(0);
            expect(first.validationErrors).toHaveLength(0);

            const message = await target.queryFirst<{
                role: string;
                model: string;
                content_text: string;
                duration_ms: number;
                input_tokens: number;
                cwd: string;
            }>('SELECT role, model, content_text, duration_ms, input_tokens, cwd FROM history_message');
            expect(message).toEqual({
                role: 'assistant',
                model: 'gpt-5',
                content_text: 'Done.',
                duration_ms: 500,
                input_tokens: 12,
                cwd: '/work/project',
            });
            const tool = await target.queryFirst<{ tool_name: string; status: string; duration_ms: number }>(
                'SELECT tool_name, status, duration_ms FROM history_tool_call',
            );
            expect(tool).toEqual({ tool_name: 'bash', status: 'completed', duration_ms: 200 });

            const second = await runOpenCodeImport({ db: target, sourceDatabase: source.path, mode: 'full' });
            expect(second.importedRecords).toBe(0);
            expect(second.skippedDuplicates).toBe(2);
            expect(await target.queryFirst<{ count: number }>('SELECT COUNT(*) AS count FROM history_message')).toEqual(
                {
                    count: 1,
                },
            );
            expect(
                await target.queryFirst<{ count: number }>('SELECT COUNT(*) AS count FROM history_tool_call'),
            ).toEqual({ count: 1 });
        } finally {
            source.db.close();
            target.close();
        }
    });

    test('returns an empty result when OpenCode has no database', async () => {
        const target = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        try {
            const result = await runOpenCodeImport({
                db: target,
                sourceDatabase: join(tmpdir(), 'missing-opencode-history.db'),
            });
            expect(result.scannedFiles).toBe(0);
            expect(result.importedRecords).toBe(0);
        } finally {
            target.close();
        }
    });

    test('retains sanitized generic tool args_raw and redacts default-recognized secrets (task 0064 AC1/AC5)', async () => {
        const source = await sourceDatabase();
        const target = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        try {
            await source.db.run('INSERT INTO session (id, directory) VALUES (?, ?)', 'session-64', '/work/project');
            await source.db.run(
                'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
                'message-64',
                'session-64',
                1_700_000_000_000,
                JSON.stringify({ role: 'assistant', time: { created: 1_700_000_000_000 } }),
            );
            await source.db.run(
                'INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)',
                'part-tool-64',
                'message-64',
                'session-64',
                1_700_000_000_002,
                JSON.stringify({
                    type: 'tool',
                    tool: 'read',
                    state: {
                        status: 'completed',
                        input: { file_path: 'keys/sk-abcdefghijklmnop1234.pem', range: { start: 1, end: 9 } },
                        output: 'ok',
                    },
                }),
            );

            const result = await runOpenCodeImport({ db: target, sourceDatabase: source.path, mode: 'full' });
            expect(result.parseErrors).toHaveLength(0);
            expect(result.validationErrors).toHaveLength(0);

            const tool = await target.queryFirst<{ tool_name: string; args_raw: string | null }>(
                'SELECT tool_name, args_raw FROM history_tool_call',
            );
            expect(tool?.tool_name).toBe('read');
            // Sanitized args persist as valid JSON with the forensic path/range queryable.
            const args = JSON.parse(tool?.args_raw ?? 'null') as {
                file_path: string;
                range: { start: number; end: number };
            };
            expect(args.range).toEqual({ start: 1, end: 9 });
            // The default redaction rules applied at the persistence seam before the write.
            expect(args.file_path).toBe('keys/[REDACTED:token].pem');
            expect(tool?.args_raw).not.toContain('sk-abcdefghijklmnop1234');
        } finally {
            source.db.close();
            target.close();
        }
    });

    test('R3 — persistence cost scales with write chunks, not existing ledger rows (0504)', async () => {
        const source = await sourceDatabase();
        const target = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        try {
            await applyHistoryImportSchema(target);
            await source.db.run('INSERT INTO session (id, directory) VALUES (?, ?)', 'session-r3', '/work/project');
            for (let i = 1; i <= 2; i += 1) {
                // Bound parameter values are hoisted into consts so the SQL text stays
                // the only string literal inside each run() call (static with ? placeholders).
                const messageId = `message-r3-${i}`;
                const messageData = JSON.stringify({
                    role: 'assistant',
                    time: { created: 1_700_000_000_000 + i },
                    modelID: 'gpt-5',
                    tokens: { input: 1, output: 1 },
                });
                await source.db.run(
                    'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
                    messageId,
                    'session-r3',
                    1_700_000_000_000 + i,
                    messageData,
                );
                const partId = `part-r3-${i}`;
                const partData = JSON.stringify({ type: 'text', text: `done ${i}` });
                await source.db.run(
                    'INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)',
                    partId,
                    messageId,
                    'session-r3',
                    1_700_000_000_001 + i,
                    partData,
                );
            }
            // Seed 10,000 UNRELATED ledger rows (a different source). A per-new-message
            // full-ledger scan or an unindexed (source, source_file) ledger delete would
            // execute ~10,000 statements here; the importer must stay O(chunks).
            for (let i = 0; i < 10_000; i += 1) {
                const unrelatedHash = `unrelated-${i}`;
                await target.run(
                    'INSERT INTO history_import_ledger (record_hash, source, source_file, source_line, split_index, target_table, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    unrelatedHash,
                    'pi',
                    'unrelated.jsonl',
                    1,
                    0,
                    'history_etl_pi',
                    '2026-01-01T00:00:00Z',
                );
            }

            let statements = 0;
            const executedSql: string[] = [];
            const counting: DbAdapter = {
                db: target.db,
                exec: (sql) => {
                    statements += 1;
                    executedSql.push(sql);
                    return target.exec(sql);
                },
                run: (sql, ...params) => {
                    statements += 1;
                    executedSql.push(sql);
                    return target.run(sql, ...params);
                },
                queryFirst: <T>(sql: string, ...params: unknown[]) => {
                    statements += 1;
                    executedSql.push(sql);
                    return target.queryFirst<T>(sql, ...params);
                },
                queryAll: <T>(sql: string, ...params: unknown[]) => {
                    statements += 1;
                    executedSql.push(sql);
                    return target.queryAll<T>(sql, ...params);
                },
                close: () => target.close(),
                batch: async (ops) => {
                    statements += ops.length;
                    for (const op of ops) executedSql.push(op.sql);
                    await target.batch(ops);
                },
            };

            const result = await runOpenCodeImport({ db: counting, sourceDatabase: source.path, mode: 'full' });

            expect(result.importedRecords).toBe(2); // 2 messages × 1 text-part entry each
            // Bounded: schema setup + 3 reads + a handful of batched writes. With 10,000
            // unrelated ledger rows, any per-record scan would blow well past this.
            expect(statements).toBeLessThan(100);
            // No new-message operation may delete ledger rows by an unindexed
            // (source, source_file) predicate — deletes are keyed by record_hash (PK) only.
            for (const sql of executedSql) {
                expect(sql).not.toMatch(/DELETE FROM history_import_ledger\s+WHERE source/);
                expect(sql).not.toMatch(/DELETE FROM history_import_ledger\s+WHERE source_file/);
            }
        } finally {
            source.db.close();
            target.close();
        }
    });

    test('R1 — full mode sweeps ledger and checkpoint rows for messages deleted from the store (0504)', async () => {
        const source = await sourceDatabase();
        const target = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        try {
            await source.db.run('INSERT INTO session (id, directory) VALUES (?, ?)', 'session-r1', '/work/project');
            await source.db.run(
                'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
                'message-r1',
                'session-r1',
                1_700_000_000_000,
                JSON.stringify({
                    role: 'assistant',
                    time: { created: 1_700_000_000_000 },
                    modelID: 'gpt-5',
                    tokens: { input: 1, output: 1 },
                }),
            );
            await source.db.run(
                'INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)',
                'part-r1',
                'message-r1',
                'session-r1',
                1_700_000_000_001,
                JSON.stringify({ type: 'text', text: 'swept' }),
            );

            const first = await runOpenCodeImport({ db: target, sourceDatabase: source.path, mode: 'full' });
            expect(first.importedRecords).toBe(1);
            expect(first.reconciliation).toEqual({ staleTargetRows: 0, staleLedgerRows: 0, staleCheckpointRows: 0 });

            // The message vanishes from the store — full mode must retire its derived rows.
            await source.db.run('DELETE FROM message WHERE id = ?', 'message-r1');

            const second = await runOpenCodeImport({ db: target, sourceDatabase: source.path, mode: 'full' });
            expect(second.reconciliation).toEqual({ staleTargetRows: 1, staleLedgerRows: 1, staleCheckpointRows: 1 });
            expect(await target.queryFirst<{ count: number }>('SELECT COUNT(*) AS count FROM history_message')).toEqual(
                { count: 0 },
            );
            expect(
                await target.queryFirst<{ count: number }>('SELECT COUNT(*) AS count FROM history_import_ledger'),
            ).toEqual({ count: 0 });
            expect(
                await target.queryFirst<{ count: number }>('SELECT COUNT(*) AS count FROM history_import_checkpoint'),
            ).toEqual({ count: 0 });

            // A second full run reports zero changes.
            const third = await runOpenCodeImport({ db: target, sourceDatabase: source.path, mode: 'full' });
            expect(third.reconciliation).toEqual({ staleTargetRows: 0, staleLedgerRows: 0, staleCheckpointRows: 0 });
        } finally {
            source.db.close();
            target.close();
        }
    });

    test('R1 — counts mapper-drifted messages as stale (exact dry-run and write counts)', async () => {
        const source = await sourceDatabase();
        const target = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        try {
            await source.db.run('INSERT INTO session (id, directory) VALUES (?, ?)', 'session-drift', '/work/project');
            await source.db.run(
                'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
                'message-drift',
                'session-drift',
                1_700_000_000_000,
                JSON.stringify({
                    role: 'assistant',
                    time: { created: 1_700_000_000_000 },
                    modelID: 'gpt-5',
                    tokens: { input: 1, output: 1 },
                }),
            );

            const first = await runOpenCodeImport({ db: target, sourceDatabase: source.path, mode: 'full' });
            expect(first.importedRecords).toBe(1);
            expect(first.reconciliation).toEqual({ staleTargetRows: 0, staleLedgerRows: 0, staleCheckpointRows: 0 });

            // Mapper drift: the same source file now produces a different record hash.
            await source.db.run(
                'UPDATE message SET data = ? WHERE id = ?',
                JSON.stringify({
                    role: 'assistant',
                    time: { created: 1_700_000_000_000 },
                    modelID: 'gpt-5',
                    tokens: { input: 2, output: 1 },
                }),
                'message-drift',
            );

            // Dry-run reports the exact stale-row count without mutating the database.
            const dryRun = await runOpenCodeImport({
                db: target,
                sourceDatabase: source.path,
                mode: 'full',
                dryRun: true,
            });
            expect(dryRun.reconciliation).toEqual({ staleTargetRows: 1, staleLedgerRows: 1, staleCheckpointRows: 0 });
            expect(dryRun.importedRecords).toBe(1);
            expect(await target.queryFirst<{ count: number }>('SELECT COUNT(*) AS count FROM history_message')).toEqual(
                { count: 1 },
            );

            // Write applies the same diff: old row deleted, new row inserted.
            const write = await runOpenCodeImport({ db: target, sourceDatabase: source.path, mode: 'full' });
            expect(write.reconciliation).toEqual({ staleTargetRows: 1, staleLedgerRows: 1, staleCheckpointRows: 0 });
            expect(write.importedRecords).toBe(1);
            expect(await target.queryFirst<{ count: number }>('SELECT COUNT(*) AS count FROM history_message')).toEqual(
                { count: 1 },
            );
            expect(
                await target.queryFirst<{ count: number }>('SELECT COUNT(*) AS count FROM history_import_ledger'),
            ).toEqual({ count: 1 });

            // A second full run reports zero changes.
            const second = await runOpenCodeImport({ db: target, sourceDatabase: source.path, mode: 'full' });
            expect(second.reconciliation).toEqual({ staleTargetRows: 0, staleLedgerRows: 0, staleCheckpointRows: 0 });
        } finally {
            source.db.close();
            target.close();
        }
    });
});
