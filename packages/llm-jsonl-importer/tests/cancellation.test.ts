import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDbAdapter, type DbAdapter } from '@gobing-ai/ts-db';
import { z } from 'zod';
import {
    HistoryImportError,
    ImportCancelledError,
    runJsonlImport,
    runOpenCodeImport,
    type SourceDefinition,
} from '../src';

const temporaryDirectories: string[] = [];

let db: DbAdapter;

beforeEach(async () => {
    db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
});

afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
        await rm(directory, { recursive: true, force: true });
    }
});

/** Write a temp JSONL fixture and return its realpath (importer normalizes source identity). */
async function fixtureFile(lines: readonly string[]): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'importer-cancellation-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'history.jsonl');
    await writeFile(file, `${lines.join('\n')}\n`);
    return realpath(file);
}

function fixedNow(): Date {
    return new Date('2026-05-30T12:00:00.000Z');
}

function cancelLine(id: string): string {
    return JSON.stringify({ id, timestamp: '2026-05-30T00:00:00.000Z', content: id });
}

/** Capture the rejection reason, failing the test when the run resolves instead. */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('expected the cancelled import to reject');
}

/**
 * Custom source whose split aborts the controller while `triggerId` is being
 * processed — cancellation arrives mid-line, before that line's writes settle.
 */
function cancelTriggeredSource(controller: AbortController, triggerId: string): SourceDefinition {
    return {
        source: 'acme-cancel',
        displayName: 'Acme Cancel Probe',
        defaultRoots: [],
        filePatterns: ['*.jsonl'],
        targetTable: 'history_etl_acme_cancel',
        splitConfig: {
            mode: 'custom',
            split: (raw) => {
                if ((raw as { id?: unknown }).id === triggerId) controller.abort();
                return [raw];
            },
        },
        fieldMap: {
            id: 'source_record_id',
            timestamp: 'created_at',
            content: 'content',
        },
        fieldTransforms: {},
        schema: z.object({
            source_record_id: z.string().min(1),
            created_at: z.string().min(1),
            content: z.string().min(1),
        }),
    };
}

describe('runJsonlImport cancellation (feature A21)', () => {
    test('already-aborted signal rejects before any invocation-owned write', async () => {
        const file = await fixtureFile([cancelLine('a1')]);
        const controller = new AbortController();
        controller.abort();

        const error = await captureRejection(
            runJsonlImport('antigravity', {
                db,
                files: [file],
                mode: 'incremental',
                now: fixedNow,
                signal: controller.signal,
            }),
        );

        expect(error).toBeInstanceOf(ImportCancelledError);
        expect(error).toBeInstanceOf(HistoryImportError);
        // The entry check precedes the schema write: not even importer-owned tables exist.
        const tables = await db.queryAll<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'history_%'",
        );
        expect(tables).toEqual([]);
    });

    test('mid-import cancellation settles the in-flight line, then rejects; resume completes from the checkpoint', async () => {
        const file = await fixtureFile([
            cancelLine('c1'),
            cancelLine('c2'),
            cancelLine('c3'),
            cancelLine('c4'),
            cancelLine('c5'),
            cancelLine('c6'),
        ]);
        const controller = new AbortController();

        const error = await captureRejection(
            runJsonlImport(cancelTriggeredSource(controller, 'c4'), {
                db,
                files: [file],
                mode: 'incremental',
                now: fixedNow,
                signal: controller.signal,
            }),
        );

        expect(error).toBeInstanceOf(ImportCancelledError);
        // c4's cancellation arrived mid-line: that line's record+ledger+checkpoint batch still
        // settled before the run rejected, so exactly c1..c4 are persisted. Generic ETL rows
        // keep the mapped record in payload_json.
        const rows = await db.queryAll<{ payload_json: string }>(
            'SELECT payload_json FROM history_etl_acme_cancel ORDER BY source_line',
        );
        expect(
            rows.map((row) => (JSON.parse(row.payload_json) as { source_record_id: string }).source_record_id),
        ).toEqual(['c1', 'c2', 'c3', 'c4']);
        const checkpoint = await db.queryFirst<{ last_imported_line: number; source_size: number | null }>(
            'SELECT last_imported_line, source_size FROM history_import_checkpoint WHERE source_file = ?',
            file,
        );
        expect(checkpoint).toEqual({ last_imported_line: 4, source_size: null });
        // No invocation-owned write lands after the rejection.
        await new Promise((resolve) => setTimeout(resolve, 20));
        const settledRows = await db.queryAll<{ count: number }>(
            'SELECT COUNT(*) AS count FROM history_etl_acme_cancel',
        );
        expect(settledRows[0]?.count).toBe(4);

        // Incremental resume (no signal) continues from the committed checkpoint; the
        // line-only checkpoint must not have armed the file-identity short-circuit.
        const resumed = await runJsonlImport(cancelTriggeredSource(controller, 'never'), {
            db,
            files: [file],
            mode: 'incremental',
            now: fixedNow,
        });
        expect(resumed.processedLines).toBe(2);
        expect(resumed.importedRecords).toBe(2);
        expect(resumed.skippedUnchangedFiles).toBe(0);
        const resumedRows = await db.queryAll<{ payload_json: string }>(
            'SELECT payload_json FROM history_etl_acme_cancel ORDER BY source_line',
        );
        expect(
            resumedRows.map((row) => (JSON.parse(row.payload_json) as { source_record_id: string }).source_record_id),
        ).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
    });

    test('cancellation during a dry-run rejects and persists nothing', async () => {
        const file = await fixtureFile([cancelLine('d1'), cancelLine('d2'), cancelLine('d3'), cancelLine('d4')]);
        const controller = new AbortController();

        const error = await captureRejection(
            runJsonlImport(cancelTriggeredSource(controller, 'd3'), {
                db,
                files: [file],
                mode: 'incremental',
                dryRun: true,
                now: fixedNow,
                signal: controller.signal,
            }),
        );

        expect(error).toBeInstanceOf(ImportCancelledError);
        const ledgerRows = await db.queryAll<{ count: number }>('SELECT COUNT(*) AS count FROM history_import_ledger');
        const checkpointRows = await db.queryAll<{ count: number }>(
            'SELECT COUNT(*) AS count FROM history_import_checkpoint',
        );
        expect(ledgerRows[0]?.count).toBe(0);
        expect(checkpointRows[0]?.count).toBe(0);
    });
});

describe('runOpenCodeImport cancellation (feature A21)', () => {
    async function sourceDatabase(): Promise<{ db: DbAdapter; path: string }> {
        const directory = await mkdtemp(join(tmpdir(), 'opencode-cancel-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'opencode.db');
        const source = await createDbAdapter({ driver: 'bun-sqlite', url: path });
        await source.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL)');
        await source.exec(
            'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)',
        );
        await source.exec(
            'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)',
        );
        await source.run('INSERT INTO session (id, directory) VALUES (?, ?)', 'session-1', '/work/project');
        await source.run(
            'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
            'message-1',
            'session-1',
            1_700_000_000_000,
            JSON.stringify({
                role: 'assistant',
                time: { created: 1_700_000_000_000, completed: 1_700_000_000_500 },
                modelID: 'gpt-5',
                path: { cwd: '/work/project' },
            }),
        );
        await source.run(
            'INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)',
            'part-text',
            'message-1',
            'session-1',
            1_700_000_000_001,
            JSON.stringify({ type: 'text', text: 'Done.' }),
        );
        return { db: source, path };
    }

    test('already-aborted signal rejects before any invocation-owned write', async () => {
        const source = await sourceDatabase();
        const target = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        const controller = new AbortController();
        controller.abort();

        const error = await captureRejection(
            runOpenCodeImport({ db: target, sourceDatabase: source.path, signal: controller.signal }),
        );

        expect(error).toBeInstanceOf(ImportCancelledError);
        const tables = await target.queryAll<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'history_%'",
        );
        expect(tables).toEqual([]);
        const sourceMessages = await source.db.queryAll<{ id: string }>('SELECT id FROM message');
        expect(sourceMessages).toHaveLength(1);
    });

    test('cancellation mid-run discards queued writes and rejects before the settlement batch', async () => {
        const source = await sourceDatabase();
        const target = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        const controller = new AbortController();
        let nowCalls = 0;

        const error = await captureRejection(
            runOpenCodeImport({
                db: target,
                sourceDatabase: source.path,
                mode: 'incremental',
                now: () => {
                    nowCalls += 1;
                    controller.abort();
                    return fixedNow();
                },
                signal: controller.signal,
            }),
        );

        expect(error).toBeInstanceOf(ImportCancelledError);
        expect(nowCalls).toBeGreaterThanOrEqual(1);
        // The queued page operations were never issued: no records, ledger rows, or checkpoints.
        const messages = await target.queryAll<{ count: number }>('SELECT COUNT(*) AS count FROM history_message');
        const ledger = await target.queryAll<{ count: number }>('SELECT COUNT(*) AS count FROM history_import_ledger');
        const checkpoints = await target.queryAll<{ count: number }>(
            'SELECT COUNT(*) AS count FROM history_import_checkpoint',
        );
        expect(messages[0]?.count).toBe(0);
        expect(ledger[0]?.count).toBe(0);
        expect(checkpoints[0]?.count).toBe(0);
    });
});
