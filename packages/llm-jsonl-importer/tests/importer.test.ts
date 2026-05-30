import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDbAdapter, type DbAdapter } from '@gobing-ai/ts-db';
import { runJsonlImport } from '../src';

let db: DbAdapter;

beforeEach(async () => {
    db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
});

describe('runJsonlImport', () => {
    test('validates rows before persisting and records parse errors without raw storage', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'ok-1', timestamp: '2026-05-30T00:00:00.000Z', content: 'hello' }),
            JSON.stringify({ id: 'bad-1', timestamp: '2026-05-30T00:00:00.000Z' }),
            '{',
        ]);

        const result = await runJsonlImport('codex', {
            db,
            files: [file],
            mode: 'full',
            now: fixedNow,
        });

        expect(result.importedRecords).toBe(1);
        expect(result.validationErrors).toHaveLength(1);
        expect(result.parseErrors).toHaveLength(1);
        const ledgerRows = await db.queryAll<{ source: string }>('SELECT source FROM history_import_ledger');
        const etlRows = await db.queryAll<{ payload_json: string }>('SELECT payload_json FROM history_etl_codex');
        expect(ledgerRows).toEqual([{ source: 'codex' }]);
        expect(etlRows).toHaveLength(1);
        expect(etlRows[0]?.payload_json).toContain('hello');
    });

    test('uses composite file checkpoints for incremental imports', async () => {
        const first = await fixtureFile([
            JSON.stringify({ id: 'one', timestamp: '2026-05-30T00:00:00.000Z', content: 'one' }),
        ]);
        const second = await fixtureFile([
            JSON.stringify({ id: 'two', timestamp: '2026-05-30T00:00:00.000Z', content: 'two' }),
        ]);

        await runJsonlImport('claude', { db, files: [first, second], mode: 'incremental', now: fixedNow });
        await writeFile(first, `${await Bun.file(first).text()}${JSON.stringify({ id: 'three', content: 'three' })}\n`);

        const result = await runJsonlImport('claude', {
            db,
            files: [first, second],
            mode: 'incremental',
            now: fixedNow,
        });

        expect(result.processedLines).toBe(1);
        expect(result.importedRecords).toBe(1);
        const checkpoints = await db.queryAll<{ source_file: string; last_imported_line: number }>(
            'SELECT source_file, last_imported_line FROM history_import_checkpoint ORDER BY source_file',
        );
        expect(
            new Map(checkpoints.map((checkpoint) => [checkpoint.source_file, checkpoint.last_imported_line])),
        ).toEqual(
            new Map([
                [first, 2],
                [second, 1],
            ]),
        );
    });

    test('deduplicates records by stable SHA-256 ledger hash', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'same', timestamp: '2026-05-30T00:00:00.000Z', content: 'same' }),
        ]);

        const first = await runJsonlImport('gemini', { db, files: [file], mode: 'full', now: fixedNow });
        const second = await runJsonlImport('gemini', { db, files: [file], mode: 'full', now: fixedNow });

        expect(first.importedRecords).toBe(1);
        expect(second.importedRecords).toBe(0);
        expect(second.skippedDuplicates).toBe(1);
        const rows = await db.queryAll<{ count: number }>('SELECT COUNT(*) AS count FROM history_etl_gemini');
        expect(rows[0]?.count).toBe(1);
    });

    test('splits Pi nested messages into one ETL row per message', async () => {
        const file = await fixtureFile([
            JSON.stringify({
                id: 'session-1',
                timestamp: '2026-05-30T00:00:00.000Z',
                messages: [
                    { id: 'm1', role: 'user', content: 'first' },
                    { id: 'm2', role: 'assistant', content: 'second' },
                ],
            }),
        ]);

        const result = await runJsonlImport('pi', { db, files: [file], mode: 'full', now: fixedNow });

        expect(result.importedRecords).toBe(2);
        const rows = await db.queryAll<{ payload_json: string }>(
            'SELECT payload_json FROM history_etl_pi ORDER BY split_index',
        );
        expect(rows.map((row) => JSON.parse(row.payload_json).content)).toEqual(['first', 'second']);
    });

    test('redacts secrets before persistence', async () => {
        const file = await fixtureFile([
            JSON.stringify({
                id: 'secret',
                timestamp: '2026-05-30T00:00:00.000Z',
                content: 'token=sk-1234567890abcdef contact robin@example.com',
            }),
        ]);

        await runJsonlImport('openclaw', { db, files: [file], mode: 'force-file', now: fixedNow });

        const rows = await db.queryAll<{ payload_json: string }>('SELECT payload_json FROM history_etl_openclaw');
        expect(rows[0]?.payload_json).toContain('[REDACTED:secret]');
        expect(rows[0]?.payload_json).toContain('[REDACTED:email]');
        expect(rows[0]?.payload_json).not.toContain('robin@example.com');
    });

    test('rejects non-object JSON rows before persistence', async () => {
        const file = await fixtureFile([JSON.stringify(['not', 'an', 'object'])]);

        const result = await runJsonlImport('opencode', { db, files: [file], mode: 'full', now: fixedNow });

        expect(result.importedRecords).toBe(0);
        expect(result.parseErrors).toEqual([
            { sourceFile: file, sourceLine: 1, reason: 'JSONL row must be an object' },
        ]);
        const rows = await db.queryAll<{ record_hash: string }>('SELECT record_hash FROM history_import_ledger');
        expect(rows).toEqual([]);
    });

    test('discovers JSONL files below roots and ignores unsupported files', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'llm-jsonl-importer-root-'));
        const nested = join(directory, 'nested');
        await mkdir(nested);
        await writeFile(
            join(nested, 'history.jsonl'),
            `${JSON.stringify({ id: 'root-1', timestamp: '2026-05-30T00:00:00.000Z', content: 'from root' })}\n`,
        );
        await writeFile(join(nested, 'notes.txt'), 'ignored');

        const result = await runJsonlImport('antigravity', { db, roots: [directory], mode: 'full', now: fixedNow });

        expect(result.scannedFiles).toBe(1);
        expect(result.importedRecords).toBe(1);
    });

    test('imports a supported root when the root itself is a file', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'root-file', timestamp: '2026-05-30T00:00:00.000Z', content: 'file root' }),
        ]);

        const result = await runJsonlImport('codex', { db, roots: [file], mode: 'full', now: fixedNow });

        expect(result.scannedFiles).toBe(1);
        expect(result.importedRecords).toBe(1);
    });

    test('falls back to a single Pi record when the nested messages field is absent', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'pi-single', timestamp: '2026-05-30T00:00:00.000Z', content: 'single' }),
        ]);

        const result = await runJsonlImport('pi', { db, files: [file], mode: 'full', now: fixedNow });

        expect(result.importedRecords).toBe(1);
        const rows = await db.queryAll<{ payload_json: string }>('SELECT payload_json FROM history_etl_pi');
        expect(JSON.parse(rows[0]?.payload_json ?? '{}')).toMatchObject({ content: 'single' });
    });
});

async function fixtureFile(lines: readonly string[]): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'llm-jsonl-importer-'));
    const file = join(directory, 'history.jsonl');
    await writeFile(file, `${lines.join('\n')}\n`);
    return file;
}

function fixedNow(): Date {
    return new Date('2026-05-30T12:00:00.000Z');
}
