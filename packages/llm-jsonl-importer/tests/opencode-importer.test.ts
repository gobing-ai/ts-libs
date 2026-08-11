import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDbAdapter, type DbAdapter } from '@gobing-ai/ts-db';
import { runOpenCodeImport } from '../src';

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
});
