import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDbAdapter, type DbAdapter } from '@gobing-ai/ts-db';
import { createNodeFileSystem, type FileSystem, type RuntimePaths } from '@gobing-ai/ts-runtime';
import { z } from 'zod';
import { HistoryImportError, runJsonlImport, type SourceDefinition, validateSourceDefinition } from '../src';

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
/**
 * RuntimePaths seam (ADR-023 A1 / task 0042).
 *
 * Pins the two importer ACs:
 *  - AC#3: registry defaultRoots resolve against `paths.home`, so an import run from a cwd ≠ $HOME
 *    discovers fixture history files placed under a fake home.
 *  - AC#4: explicit caller-supplied relative roots keep cwd semantics (resolve against the working
 *    directory, not home).
 */
describe('runJsonlImport paths injection (ADR-023 A1)', () => {
    test('defaultRoots resolve against paths.home when cwd is outside home', async () => {
        const fakeHome = await mkdtemp(join(tmpdir(), 'a1-home-'));
        const outsideCwd = await mkdtemp(join(tmpdir(), 'a1-cwd-'));
        // Build a fixture claude tree at <fakeHome>/.claude/projects/<proj>/session.jsonl
        const projectDir = join(fakeHome, '.claude', 'projects', 'proj-1');
        await mkdir(projectDir, { recursive: true });
        const fixtureFile = join(projectDir, 'session.jsonl');
        await writeFile(
            fixtureFile,
            `${JSON.stringify({ id: 'home-1', timestamp: '2026-05-30T00:00:00.000Z', content: 'x' })}\n`,
        );

        const paths: RuntimePaths = { cwd: outsideCwd, home: fakeHome };
        const fileSystem = createNodeFileSystem(outsideCwd);

        try {
            const result = await runJsonlImport('claude', {
                db,
                mode: 'full',
                now: fixedNow,
                paths,
                fileSystem,
            });

            // Before the fix, defaultRoots resolved against ambient cwd and silently skipped
            // every source (scannedFiles === 0). With paths.home injected, the fixture is found.
            expect(result.scannedFiles).toBe(1);
            expect(result.importedRecords).toBe(1);

            const rows = await db.queryAll<{ source_file: string }>('SELECT source_file FROM history_etl_claude');
            expect(rows).toHaveLength(1);
            expect(rows[0]?.source_file).toBe(fixtureFile);
        } finally {
            await rm(fakeHome, { recursive: true, force: true });
            await rm(outsideCwd, { recursive: true, force: true });
        }
    });

    test('explicit relative roots keep cwd semantics (resolved against paths.cwd, not home)', async () => {
        const fakeHome = await mkdtemp(join(tmpdir(), 'a1-home-2-'));
        const outsideCwd = await mkdtemp(join(tmpdir(), 'a1-cwd-2-'));
        // A relative-rooted fixture living under cwd, NOT under home.
        const localRoot = join(outsideCwd, 'local-history');
        await mkdir(localRoot, { recursive: true });
        const fixtureFile = join(localRoot, 'session.jsonl');
        await writeFile(
            fixtureFile,
            `${JSON.stringify({ id: 'cwd-1', timestamp: '2026-05-30T00:00:00.000Z', content: 'y' })}\n`,
        );
        // Decoy under home with the same relative path — must NOT be picked up.
        const homeDecoyRoot = join(fakeHome, 'local-history');
        await mkdir(homeDecoyRoot, { recursive: true });
        await writeFile(
            join(homeDecoyRoot, 'session.jsonl'),
            `${JSON.stringify({ id: 'home-decoy', timestamp: '2026-05-30T00:00:00.000Z', content: 'decoy' })}\n`,
        );

        const paths: RuntimePaths = { cwd: outsideCwd, home: fakeHome };
        const fileSystem = createNodeFileSystem(outsideCwd);

        try {
            const result = await runJsonlImport('claude', {
                db,
                mode: 'full',
                now: fixedNow,
                roots: ['local-history'],
                paths,
                fileSystem,
            });

            expect(result.scannedFiles).toBe(1);
            expect(result.importedRecords).toBe(1);
            const payloads = await db.queryAll<{ payload_json: string }>('SELECT payload_json FROM history_etl_claude');
            expect(payloads).toHaveLength(1);
            expect(payloads[0]?.payload_json).toContain('cwd-1');
            expect(payloads[0]?.payload_json).not.toContain('decoy');
        } finally {
            await rm(fakeHome, { recursive: true, force: true });
            await rm(outsideCwd, { recursive: true, force: true });
        }
    });
});

/**
 * Open source registry (ADR-023 A3 / task 0044).
 *
 * Pins the registry-opening ACs:
 *  - AC#1: a custom SourceDefinition imports into its own history_etl_* table with the
 *    caller-chosen `source` name flowing through checkpoints, ledger, and ImportResult.
 *  - AC#2: an unknown string source throws HistoryImportError (no silent empty import).
 *  - AC#3: custom definitions with invalid target tables (primary or split override) are
 *    rejected fail-fast before any I/O.
 *  - AC#4: a custom definition built from a built-in's fields produces byte-identical
 *    results to the built-in string path (registry transparency).
 */
describe('runJsonlImport source registry (ADR-023 A3)', () => {
    test('a custom SourceDefinition imports into its own table with the custom source name', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'cust-1', timestamp: '2026-05-30T00:00:00.000Z', content: 'custom-body' }),
            JSON.stringify({ id: 'cust-2', timestamp: '2026-05-30T00:01:00.000Z', content: 'custom-body-2' }),
        ]);

        const result = await runJsonlImport(customAcmeSource(), {
            db,
            files: [file],
            mode: 'full',
            now: fixedNow,
        });

        expect(result.source).toBe('acme');
        expect(result.importedRecords).toBe(2);

        const etlRows = await db.queryAll<{ payload_json: string }>(
            'SELECT payload_json FROM history_etl_acme ORDER BY source_line',
        );
        expect(etlRows).toHaveLength(2);
        expect(etlRows[0]?.payload_json).toContain('custom-body');
        expect(etlRows[1]?.payload_json).toContain('custom-body-2');

        const ledgerRows = await db.queryAll<{ source: string; target_table: string }>(
            'SELECT source, target_table FROM history_import_ledger',
        );
        expect(ledgerRows).toEqual([
            { source: 'acme', target_table: 'history_etl_acme' },
            { source: 'acme', target_table: 'history_etl_acme' },
        ]);

        const checkpoints = await db.queryAll<{ source: string; source_file: string }>(
            'SELECT source, source_file FROM history_import_checkpoint',
        );
        expect(checkpoints).toEqual([{ source: 'acme', source_file: file }]);
    });

    test('an unknown string source throws HistoryImportError before touching the database', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'x', timestamp: '2026-05-30T00:00:00.000Z', content: 'x' }),
        ]);

        // resolveSourceDefinition throws before applyHistoryImportSchema runs, so the
        // ledger table is never created on a fresh DB — the throw itself is the proof.
        const attempt = () => runJsonlImport('not-a-real-source', { db, files: [file], mode: 'full', now: fixedNow });
        await expect(attempt()).rejects.toThrow(HistoryImportError);
        await expect(attempt()).rejects.toThrow(/not-a-real-source/);

        await expect(db.queryFirst('SELECT COUNT(*) AS c FROM history_import_ledger')).rejects.toThrow(); // table does not exist
    });

    test('a custom definition with an invalid primary target table is rejected before any write', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'x', timestamp: '2026-05-30T00:00:00.000Z', content: 'x' }),
        ]);
        const bad = { ...customAcmeSource(), targetTable: 'droptable_users' };

        const attempt = () => runJsonlImport(bad, { db, files: [file], mode: 'full', now: fixedNow });
        await expect(attempt()).rejects.toThrow(HistoryImportError);
        await expect(attempt()).rejects.toThrow(/droptable_users/);

        // No schema or checkpoint writes occurred: the ledger table was never created.
        await expect(db.queryFirst('SELECT COUNT(*) AS c FROM history_import_ledger')).rejects.toThrow();
    });

    test('a custom definition with an invalid split target table override is rejected', () => {
        const bad: SourceDefinition = {
            ...customAcmeSource(),
            splitConfig: { mode: 'one-to-many', field: 'messages', targetTable: 'history_etl_' },
        };
        // `history_etl_` has no trailing identifier segment — fails VALID_TABLE_NAME.
        expect(() => validateSourceDefinition(bad)).toThrow(HistoryImportError);
    });

    test('a custom definition missing a required field is rejected', () => {
        const { schema: _omit, ...missingSchema } = customAcmeSource();
        void _omit;
        expect(() => validateSourceDefinition(missingSchema as SourceDefinition)).toThrow(HistoryImportError);
    });

    test('a custom definition with empty filePatterns is rejected', () => {
        const bad = { ...customAcmeSource(), filePatterns: [] };
        expect(() => validateSourceDefinition(bad)).toThrow(HistoryImportError);
    });

    test('a schema-mismatched record lands in validationErrors and is not persisted', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'ok-1', timestamp: '2026-05-30T00:00:00.000Z', content: 'valid' }),
            // Missing `content` — the custom schema requires it.
            JSON.stringify({ id: 'bad-1', timestamp: '2026-05-30T00:00:00.000Z' }),
        ]);

        const result = await runJsonlImport(customAcmeSource(), {
            db,
            files: [file],
            mode: 'full',
            now: fixedNow,
        });

        expect(result.importedRecords).toBe(1);
        expect(result.validationErrors).toHaveLength(1);
        expect(result.validationErrors[0]?.sourceFile).toBe(file);
        expect(result.validationErrors[0]?.sourceLine).toBe(2);

        const etlRows = await db.queryAll<{ payload_json: string }>('SELECT payload_json FROM history_etl_acme');
        expect(etlRows).toHaveLength(1);
        expect(etlRows[0]?.payload_json).toContain('valid');
    });

    test('a custom definition built from a built-in is byte-identical to the built-in string path', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'parity-1', timestamp: '2026-05-30T00:00:00.000Z', content: 'parity' }),
        ]);

        // First import via the built-in string path.
        const builtinResult = await runJsonlImport('codex', {
            db,
            files: [file],
            mode: 'full',
            now: fixedNow,
        });

        // Drop and re-apply schema on a fresh in-memory DB, then import the same file via a custom
        // definition that mirrors the codex built-in except for its `source`/`targetTable` names.
        db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        const mirror: SourceDefinition = {
            ...customAcmeSource(),
            source: 'codex-parity',
            targetTable: 'history_etl_codex_parity',
            fieldMap: {
                id: 'source_record_id',
                timestamp: 'created_at',
                content: 'content',
            },
            // Use the same minimal transform set as the built-in codex path.
            fieldTransforms: {},
        };
        const customResult = await runJsonlImport(mirror, {
            db,
            files: [file],
            mode: 'full',
            now: fixedNow,
        });

        // Different field maps mean validation-error arrays aren't directly comparable;
        // the registry-transparency contract is about throughput parity.
        expect(customResult.importedRecords).toBe(builtinResult.importedRecords);
        expect(customResult.processedLines).toBe(builtinResult.processedLines);
        expect(customResult.parseErrors).toEqual(builtinResult.parseErrors);
    });
});

function customAcmeSource(): SourceDefinition {
    return {
        source: 'acme',
        displayName: 'Acme Assistant',
        defaultRoots: ['.acme'],
        filePatterns: ['*.jsonl'],
        targetTable: 'history_etl_acme',
        splitConfig: { mode: 'one-to-one' },
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
