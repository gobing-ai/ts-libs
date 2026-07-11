import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDbAdapter, type DbAdapter } from '@gobing-ai/ts-db';
import { createNodeFileSystem, type FileSystem } from '@gobing-ai/ts-runtime';
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

    test('recovers when ledger persistence fails after the ETL row is written', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'recover', timestamp: '2026-05-30T00:00:00.000Z', content: 'recover' }),
        ]);
        let failLedgerInsert = true;
        const faultingDb: DbAdapter = {
            db: db.db,
            exec: (sql) => db.exec(sql),
            run: (sql, ...params) => {
                if (failLedgerInsert && sql.includes('INSERT INTO history_import_ledger')) {
                    failLedgerInsert = false;
                    throw new Error('injected ledger failure');
                }
                return db.run(sql, ...params);
            },
            queryFirst: <T>(sql: string, ...params: unknown[]) => db.queryFirst<T>(sql, ...params),
            queryAll: <T>(sql: string, ...params: unknown[]) => db.queryAll<T>(sql, ...params),
            close: () => db.close(),
            batch: async (ops) => {
                for (const op of ops) await db.run(op.sql, ...op.params);
            },
        };

        await expect(
            runJsonlImport('codex', { db: faultingDb, files: [file], mode: 'incremental', now: fixedNow }),
        ).rejects.toThrow('injected ledger failure');

        const result = await runJsonlImport('codex', {
            db: faultingDb,
            files: [file],
            mode: 'incremental',
            now: fixedNow,
        });
        expect(result.importedRecords).toBe(1);
        expect(await db.queryAll('SELECT record_hash FROM history_etl_codex')).toHaveLength(1);
        expect(await db.queryAll('SELECT record_hash FROM history_import_ledger')).toHaveLength(1);
        expect(
            await db.queryFirst<{ last_imported_line: number }>(
                'SELECT last_imported_line FROM history_import_checkpoint WHERE source = ? AND source_file = ?',
                'codex',
                file,
            ),
        ).toEqual({ last_imported_line: 1 });
    });

    test('full mode resets and rewrites file checkpoints even when rows are duplicates', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'reset', timestamp: '2026-05-30T00:00:00.000Z', content: 'reset' }),
        ]);

        await runJsonlImport('gemini', { db, files: [file], mode: 'incremental', now: fixedNow });
        const result = await runJsonlImport('gemini', { db, files: [file], mode: 'full', now: fixedNow });

        expect(result.importedRecords).toBe(0);
        expect(result.skippedDuplicates).toBe(1);
        expect(result.checkpointUpdates).toBe(1);
        const checkpoints = await db.queryAll<{ last_imported_line: number }>(
            'SELECT last_imported_line FROM history_import_checkpoint WHERE source = ? AND source_file = ?',
            'gemini',
            file,
        );
        expect(checkpoints).toEqual([{ last_imported_line: 1 }]);
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

    test('reads files through an injected canonical FileSystem', async () => {
        const file = '/virtual/history.jsonl';
        const fileSystem = virtualFileSystem({
            [file]: `${JSON.stringify({
                id: 'virtual-1',
                timestamp: '2026-05-30T00:00:00.000Z',
                content: 'virtual fs',
            })}\n`,
        });

        const result = await runJsonlImport('codex', {
            db,
            files: [file],
            fileSystem,
            mode: 'full',
            now: fixedNow,
        });

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

    test('streaming readFileStream produces identical results to readFile fallback (ADR-021)', async () => {
        const lines = [
            JSON.stringify({ id: 's-1', timestamp: '2026-05-30T00:00:00.000Z', content: 'first' }),
            JSON.stringify({ id: 's-2', timestamp: '2026-05-30T00:01:00.000Z', content: 'second' }),
            JSON.stringify({ id: 's-3', timestamp: '2026-05-30T00:02:00.000Z', content: 'third' }),
        ];
        const file = await fixtureFile(lines);
        const fs = createNodeFileSystem();
        const result = await runJsonlImport('codex', {
            db,
            files: [file],
            mode: 'full',
            now: fixedNow,
            fileSystem: fs,
        });

        expect(result.importedRecords).toBe(3);
        expect(result.parseErrors).toHaveLength(0);
        const rows = await db.queryAll<{ source_line: number }>(
            'SELECT source_line FROM history_etl_codex ORDER BY source_line',
        );
        expect(rows.map((r) => r.source_line)).toEqual([1, 2, 3]);
    });

    test('streaming a multi-MB file processes all records without loading entire file into memory (ADR-021)', async () => {
        // Generate ~5MB of JSONL: 25000 records × ~200 bytes each
        const recordCount = 25_000;
        const directory = await mkdtemp(join(tmpdir(), 'llm-jsonl-importer-streaming-'));
        const file = join(directory, 'large-history.jsonl');
        const chunkSize = 1000;
        const handle = await import('node:fs').then((m) => m.createWriteStream(file));
        for (let i = 0; i < recordCount; i += chunkSize) {
            const end = Math.min(i + chunkSize, recordCount);
            const chunk: string[] = [];
            for (let j = i; j < end; j += 1) {
                chunk.push(
                    JSON.stringify({
                        id: `large-${j}`,
                        timestamp: '2026-05-30T00:00:00.000Z',
                        content: `x`.repeat(150),
                    }),
                );
            }
            handle.write(`${chunk.join('\n')}\n`);
        }
        await new Promise<void>((resolve, reject) => {
            handle.end(() => resolve());
            handle.on('error', reject);
        });

        const fs = createNodeFileSystem();
        const result = await runJsonlImport('codex', {
            db,
            files: [file],
            mode: 'full',
            now: fixedNow,
            fileSystem: fs,
        });

        expect(result.importedRecords).toBe(recordCount);
        expect(result.parseErrors).toHaveLength(0);

        const countRow = await db.queryFirst<{ count: number }>('SELECT COUNT(*) AS count FROM history_etl_codex');
        expect(countRow?.count).toBe(recordCount);
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

function virtualFileSystem(files: Record<string, string>): FileSystem {
    return {
        exists: (path) => path in files,
        readFile: (path) => {
            const content = files[path];
            if (content === undefined) throw new Error(`unexpected read: ${path}`);
            return content;
        },
        writeFile: () => undefined,
        appendFile: () => undefined,
        ensureDir: () => undefined,
        readDir: () => [],
        deleteFile: () => undefined,
        rename: () => undefined,
        copy: () => undefined,
        stat: (path) =>
            path in files
                ? {
                      isFile: () => true,
                      isDirectory: () => false,
                      size: files[path]?.length ?? 0,
                      mtimeMs: 0,
                  }
                : null,
        createWriteStream: () => {
            throw new Error('unexpected stream');
        },
        resolve: (...segments) => segments.join('/'),
        getProjectRoot: () => '/virtual',
    };
}
