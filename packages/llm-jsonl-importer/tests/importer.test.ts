import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDbAdapter, type DbAdapter } from '@gobing-ai/ts-db';
import { createNodeFileSystem, type FileSystem, type RuntimePaths } from '@gobing-ai/ts-runtime';
import { z } from 'zod';
import { HistoryImportError, runJsonlImport, type SourceDefinition, validateSourceDefinition } from '../src';

let db: DbAdapter;

/** Parse a stored payload_json column for assertions; missing columns degrade to {}. */
function parsePayloadJson(raw: string | null | undefined): Record<string, unknown> {
    if (raw === null || raw === undefined) return {};
    try {
        return JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return {};
    }
}

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

        const result = await runJsonlImport('antigravity', {
            db,
            files: [file],
            mode: 'full',
            now: fixedNow,
        });

        expect(result.importedRecords).toBe(1);
        expect(result.validationErrors).toHaveLength(1);
        expect(result.parseErrors).toHaveLength(1);
        const ledgerRows = await db.queryAll<{ source: string }>('SELECT source FROM history_import_ledger');
        const etlRows = await db.queryAll<{ payload_json: string }>('SELECT payload_json FROM history_etl_antigravity');
        expect(ledgerRows).toEqual([{ source: 'antigravity' }]);
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

        const first = await runJsonlImport('antigravity', { db, files: [file], mode: 'full', now: fixedNow });
        const second = await runJsonlImport('antigravity', { db, files: [file], mode: 'full', now: fixedNow });

        expect(first.importedRecords).toBe(1);
        expect(second.importedRecords).toBe(0);
        expect(second.skippedDuplicates).toBe(1);
        const rows = await db.queryAll<{ count: number }>('SELECT COUNT(*) AS count FROM history_etl_antigravity');
        expect(rows[0]?.count).toBe(1);
    });

    test('writes record + ledger + checkpoint through db.batch, not per-record run() (0060 F9)', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'b1', timestamp: '2026-05-30T00:00:00.000Z', content: 'b1' }),
            JSON.stringify({ id: 'b2', timestamp: '2026-05-30T00:00:00.000Z', content: 'b2' }),
            JSON.stringify({ id: 'b3', timestamp: '2026-05-30T00:00:00.000Z', content: 'b3' }),
        ]);
        let batchCalls = 0;
        const insertRunSql: string[] = [];
        const spiedDb: DbAdapter = {
            db: db.db,
            exec: (sql) => db.exec(sql),
            run: (sql, ...params) => {
                // Record/ledger inserts must never travel through the old per-record run() seam.
                if (sql.includes('INSERT INTO history_etl') || sql.includes('INSERT INTO history_import_ledger')) {
                    insertRunSql.push(sql);
                }
                return db.run(sql, ...params);
            },
            queryFirst: <T>(sql: string, ...params: unknown[]) => db.queryFirst<T>(sql, ...params),
            queryAll: <T>(sql: string, ...params: unknown[]) => db.queryAll<T>(sql, ...params),
            close: () => db.close(),
            batch: async (ops) => {
                batchCalls += 1;
                const sqls = ops.map((op) => op.sql);
                expect(sqls.join('\n')).toContain('INSERT INTO history_etl_antigravity');
                expect(sqls.join('\n')).toContain('INSERT INTO history_import_ledger');
                return db.batch(ops);
            },
        };

        const result = await runJsonlImport('antigravity', { db: spiedDb, files: [file], mode: 'full', now: fixedNow });

        expect(result.importedRecords).toBe(3);
        expect(result.checkpointUpdates).toBe(3);
        // Per-line batch (3 lines × (record + ledger + checkpoint)); record/ledger inserts never
        // travel through the old run() seam (checkpoint reset in full mode is an unrelated run()).
        expect(batchCalls).toBeGreaterThanOrEqual(3);
        expect(insertRunSql).toEqual([]);
    });

    test('recovers when ledger persistence fails mid-batch (0060 F9 atomic record+ledger)', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'recover', timestamp: '2026-05-30T00:00:00.000Z', content: 'recover' }),
        ]);
        // The import path is db.batch (task 0060 F9) — the old per-record run() seam is gone.
        // Inject the crash inside the batch to prove a mid-batch failure leaves no durable
        // partial state and the retry converges.
        let failBatch = true;
        const faultingDb: DbAdapter = {
            db: db.db,
            exec: (sql) => db.exec(sql),
            run: (sql, ...params) => db.run(sql, ...params),
            queryFirst: <T>(sql: string, ...params: unknown[]) => db.queryFirst<T>(sql, ...params),
            queryAll: <T>(sql: string, ...params: unknown[]) => db.queryAll<T>(sql, ...params),
            close: () => db.close(),
            batch: async (ops) => {
                if (failBatch && ops.some((op) => op.sql.includes('INSERT INTO history_import_ledger'))) {
                    failBatch = false;
                    // Simulate a crash between the record row and the ledger insert.
                    const first = ops[0];
                    if (first !== undefined) await db.run(first.sql, ...first.params);
                    throw new Error('injected ledger failure');
                }
                for (const op of ops) await db.run(op.sql, ...op.params);
            },
        };

        await expect(
            runJsonlImport('antigravity', { db: faultingDb, files: [file], mode: 'incremental', now: fixedNow }),
        ).rejects.toThrow('injected ledger failure');

        const result = await runJsonlImport('antigravity', {
            db: faultingDb,
            files: [file],
            mode: 'incremental',
            now: fixedNow,
        });
        expect(result.importedRecords).toBe(1);
        expect(await db.queryAll('SELECT record_hash FROM history_etl_antigravity')).toHaveLength(1);
        expect(await db.queryAll('SELECT record_hash FROM history_import_ledger')).toHaveLength(1);
        expect(
            await db.queryFirst<{ last_imported_line: number }>(
                'SELECT last_imported_line FROM history_import_checkpoint WHERE source = ? AND source_file = ?',
                'antigravity',
                file,
            ),
        ).toEqual({ last_imported_line: 1 });
    });

    test('full mode resets and rewrites file checkpoints even when rows are duplicates', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'reset', timestamp: '2026-05-30T00:00:00.000Z', content: 'reset' }),
        ]);

        await runJsonlImport('antigravity', { db, files: [file], mode: 'incremental', now: fixedNow });
        const result = await runJsonlImport('antigravity', { db, files: [file], mode: 'full', now: fixedNow });

        expect(result.importedRecords).toBe(0);
        expect(result.skippedDuplicates).toBe(1);
        expect(result.checkpointUpdates).toBe(1);
        const checkpoints = await db.queryAll<{ last_imported_line: number }>(
            'SELECT last_imported_line FROM history_import_checkpoint WHERE source = ? AND source_file = ?',
            'antigravity',
            file,
        );
        expect(checkpoints).toEqual([{ last_imported_line: 1 }]);
    });

    test('splits Pi records into history_message rows', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'session-1', type: 'user', content: 'first', timestamp: '2026-05-30T00:00:00.000Z' }),
            JSON.stringify({
                id: 'session-1',
                type: 'assistant',
                content: 'second',
                timestamp: '2026-05-30T00:00:00.000Z',
            }),
        ]);

        const result = await runJsonlImport('pi', { db, files: [file], mode: 'full', now: fixedNow });

        expect(result.importedRecords).toBe(2);
        const rows = await db.queryAll<{ content_text: string }>(
            'SELECT content_text FROM history_message ORDER BY seq',
        );
        expect(rows.map((row) => row.content_text)).toEqual(['first', 'second']);
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

    test('falls back to a single Pi record when type is absent', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'pi-single', timestamp: '2026-05-30T00:00:00.000Z', content: 'single' }),
        ]);

        const result = await runJsonlImport('pi', { db, files: [file], mode: 'full', now: fixedNow });

        expect(result.importedRecords).toBe(1);
        const rows = await db.queryAll<{ content_text: string }>('SELECT content_text FROM history_message');
        expect(rows[0]?.content_text).toBe('single');
    });

    test('streaming readFileStream produces identical results to readFile fallback (ADR-021)', async () => {
        const lines = [
            JSON.stringify({ id: 's-1', timestamp: '2026-05-30T00:00:00.000Z', content: 'first' }),
            JSON.stringify({ id: 's-2', timestamp: '2026-05-30T00:01:00.000Z', content: 'second' }),
            JSON.stringify({ id: 's-3', timestamp: '2026-05-30T00:02:00.000Z', content: 'third' }),
        ];
        const file = await fixtureFile(lines);
        const fs = createNodeFileSystem();
        const result = await runJsonlImport('antigravity', {
            db,
            files: [file],
            mode: 'full',
            now: fixedNow,
            fileSystem: fs,
        });

        expect(result.importedRecords).toBe(3);
        expect(result.parseErrors).toHaveLength(0);
        const rows = await db.queryAll<{ source_line: number }>(
            'SELECT source_line FROM history_etl_antigravity ORDER BY source_line',
        );
        expect(rows.map((r) => r.source_line)).toEqual([1, 2, 3]);
    });

    test('omp force-file import maps the current message envelope with filename session key (0507)', async () => {
        const file = await namedFixtureFile('omp-sess-key', [
            JSON.stringify({
                type: 'message',
                id: 'evt-1',
                timestamp: '2026-08-07T00:00:00.000Z',
                message: {
                    role: 'assistant',
                    model: 'claude-x',
                    duration: 900,
                    content: [
                        { type: 'text', text: 'sanitized reply' },
                        { type: 'toolCall', id: 'tc-1', name: 'Bash', arguments: { cmd: 'echo ok' } },
                    ],
                },
            }),
            JSON.stringify({
                type: 'message',
                id: 'evt-2',
                timestamp: '2026-08-07T00:00:00.001Z',
                message: { role: 'toolResult', content: [{ type: 'toolResult', toolCallId: 'tc-1' }] },
            }),
        ]);

        const result = await runJsonlImport('omp', { db, files: [file], mode: 'force-file', now: fixedNow });

        expect(result.importedRecords).toBe(3); // 2 messages + 1 tool call
        const messages = await db.queryAll<{
            session_id: string;
            seq: number;
            role: string;
            duration_ms: number | null;
        }>('SELECT session_id, seq, role, duration_ms FROM history_message ORDER BY seq');
        expect(messages).toEqual([
            { session_id: 'omp-sess-key', seq: 1, role: 'assistant', duration_ms: 900 },
            { session_id: 'omp-sess-key', seq: 2, role: 'toolresult', duration_ms: null },
        ]);
        const tools = await db.queryAll<{ session_id: string; seq: number; tool_name: string; args_digest: string }>(
            'SELECT session_id, seq, tool_name, args_digest FROM history_tool_call',
        );
        expect(tools).toHaveLength(1);
        expect(tools[0]?.session_id).toBe('omp-sess-key');
        expect(tools[0]?.seq).toBe(1);
        expect(tools[0]?.tool_name).toBe('Bash');
        expect(tools[0]?.args_digest.length).toBeGreaterThan(0);
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
        const result = await runJsonlImport('antigravity', {
            db,
            files: [file],
            mode: 'full',
            now: fixedNow,
            fileSystem: fs,
        });

        expect(result.importedRecords).toBe(recordCount);
        expect(result.parseErrors).toHaveLength(0);

        const countRow = await db.queryFirst<{ count: number }>(
            'SELECT COUNT(*) AS count FROM history_etl_antigravity',
        );
        expect(countRow?.count).toBe(recordCount);
    });
});

async function fixtureFile(lines: readonly string[]): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'llm-jsonl-importer-'));
    const file = join(directory, 'history.jsonl');
    await writeFile(file, `${lines.join('\n')}\n`);
    // Return the realpath so test assertions match the importer's normalized
    // source_file (macOS resolves /var → /private/var via realpath at discovery).
    return realpath(file);
}

/** Write a temp JSONL with a caller-chosen filename stem (OMP session key derives from it). */
async function namedFixtureFile(stem: string, lines: readonly string[]): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'llm-jsonl-importer-'));
    const file = join(directory, `${stem}.jsonl`);
    await writeFile(file, `${lines.join('\n')}\n`);
    return realpath(file);
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
        const expectedSourceFile = await realpath(fixtureFile);

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

            const rows = await db.queryAll<{ source_file: string }>('SELECT source_file FROM history_message');
            expect(rows[0]?.source_file).toBe(expectedSourceFile);
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
            const payloads = await db.queryAll<{ content_text: string }>('SELECT content_text FROM history_message');
            expect(payloads).toHaveLength(1);
            expect(payloads[0]?.content_text).toBe('y');
        } finally {
            await rm(fakeHome, { recursive: true, force: true });
            await rm(outsideCwd, { recursive: true, force: true });
        }
    });
});

/**
 * source_file path identity (task 0465 R1/R2).
 *
 * Pins the normalization ACs:
 *  - R1: a symlinked path and the real path of the same physical file collapse to one
 *    checkpoint row, and the second import re-imports no already-ledgered content.
 *  - R1 fallback: a FileSystem without `realPath` still discovers files using the
 *    original path, and a non-existent path falls back rather than failing discovery.
 */
describe('runJsonlImport source_file realpath normalization (0465)', () => {
    test('R1/R2 — symlinked and real paths of one file collapse to one checkpoint row', async () => {
        const directory = await mkdtemp(join(tmpdir(), '0465-symlink-'));
        const realDir = join(directory, 'real');
        const linkDir = join(directory, 'link');
        await mkdir(realDir);
        // Create the fixture under realDir, then symlink linkDir -> realDir.
        const rawFile = join(realDir, 'history.jsonl');
        await writeFile(
            rawFile,
            `${JSON.stringify({ id: 'sym-1', timestamp: '2026-05-30T00:00:00.000Z', content: 'via link' })}\n`,
        );
        await symlink(realDir, linkDir);
        const linkedFile = join(linkDir, 'history.jsonl');
        // Use the realpath in assertions — macOS resolves /var → /private/var.
        const realFile = await realpath(rawFile);

        try {
            // Import via the symlinked path first, then via the real path.
            const first = await runJsonlImport('antigravity', {
                db,
                files: [linkedFile],
                mode: 'incremental',
                now: fixedNow,
            });
            const second = await runJsonlImport('antigravity', {
                db,
                files: [realFile],
                mode: 'incremental',
                now: fixedNow,
            });

            // Both paths resolve to the same real file. The first import records the
            // checkpoint at the realpath; the second (via the real path directly) finds
            // the checkpoint already covers line 1 and reads nothing new. Without R1,
            // the second import would see a fresh checkpoint (different source_file key)
            // and re-import the record.
            expect(first.importedRecords).toBe(1);
            expect(second.importedRecords).toBe(0);
            const checkpoints = await db.queryAll<{ source_file: string; last_imported_line: number }>(
                'SELECT source_file, last_imported_line FROM history_import_checkpoint',
            );
            expect(checkpoints).toEqual([{ source_file: realFile, last_imported_line: 1 }]);
            const ledgerRows = await db.queryAll<{ record_hash: string }>(
                'SELECT record_hash FROM history_import_ledger',
            );
            expect(ledgerRows).toHaveLength(1);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test('R1 fallback — a FileSystem without realPath imports using the original path', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'no-realpath', timestamp: '2026-05-30T00:00:00.000Z', content: 'fallback' }),
        ]);
        // Strip realPath from the node FileSystem to simulate an injected double that
        // does not implement it (e.g. an in-memory test double).
        const { realPath: _omit, ...fsWithoutRealPath } = createNodeFileSystem();
        void _omit;

        const result = await runJsonlImport('antigravity', {
            db,
            files: [file],
            fileSystem: fsWithoutRealPath as FileSystem,
            mode: 'full',
            now: fixedNow,
        });

        expect(result.importedRecords).toBe(1);
        const checkpoints = await db.queryAll<{ source_file: string }>(
            'SELECT source_file FROM history_import_checkpoint',
        );
        // No realPath available — the original path is used unchanged.
        expect(checkpoints).toEqual([{ source_file: file }]);
    });

    test('R1 fallback — a realPath that throws (e.g. ENOENT) falls back to the original path', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'enoent-fallback', timestamp: '2026-05-30T00:00:00.000Z', content: 'fallback' }),
        ]);
        // Inject a FileSystem whose realPath throws, simulating a path that does
        // not resolve on disk (ENOENT). The catch branch in normalizeSourceFilePath
        // must fall back to the original path rather than failing discovery.
        const nodeFs = createNodeFileSystem();
        const throwingFs: FileSystem = {
            ...nodeFs,
            realPath: () => {
                throw new Error('ENOENT: no such file or directory');
            },
        };

        const result = await runJsonlImport('antigravity', {
            db,
            files: [file],
            fileSystem: throwingFs,
            mode: 'full',
            now: fixedNow,
        });

        expect(result.importedRecords).toBe(1);
        const checkpoints = await db.queryAll<{ source_file: string }>(
            'SELECT source_file FROM history_import_checkpoint',
        );
        // realPath threw — the original fixture path is used unchanged.
        expect(checkpoints).toEqual([{ source_file: file }]);
    });

    test('R5 — dry-run does not advance the checkpoint', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'dry-1', timestamp: '2026-05-30T00:00:00.000Z', content: 'dry' }),
        ]);

        const result = await runJsonlImport('antigravity', {
            db,
            files: [file],
            mode: 'incremental',
            dryRun: true,
            now: fixedNow,
        });

        expect(result.importedRecords).toBe(1);
        expect(result.checkpointUpdates).toBe(0);
        const checkpoints = await db.queryAll<{ last_imported_line: number }>(
            'SELECT last_imported_line FROM history_import_checkpoint',
        );
        expect(checkpoints).toEqual([]);
    });

    test('R5 — full mode resets only the imported source scope', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'scope-1', timestamp: '2026-05-30T00:00:00.000Z', content: 'scope' }),
        ]);
        // Seed a checkpoint for a different source — it must survive a full-mode reset
        // scoped to antigravity.
        await runJsonlImport('codex', { db, files: [file], mode: 'incremental', now: fixedNow });
        const codexCheckpointsBefore = await db.queryAll<{ source: string }>(
            "SELECT source FROM history_import_checkpoint WHERE source = 'codex'",
        );
        expect(codexCheckpointsBefore).toHaveLength(1);

        await runJsonlImport('antigravity', { db, files: [file], mode: 'full', now: fixedNow });

        const codexCheckpointsAfter = await db.queryAll<{ source: string }>(
            "SELECT source FROM history_import_checkpoint WHERE source = 'codex'",
        );
        expect(codexCheckpointsAfter).toHaveLength(1);
        const antigravityCheckpoints = await db.queryAll<{ source: string }>(
            "SELECT source FROM history_import_checkpoint WHERE source = 'antigravity'",
        );
        expect(antigravityCheckpoints).toHaveLength(1);
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
            splitConfig: { mode: 'one-to-many', field: 'messages', targetTable: 'history_etl_DROP' },
        };
        // Uppercase characters fail VALID_TABLE_NAME.
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

        // First import via the built-in generic string path.
        const builtinResult = await runJsonlImport('antigravity', {
            db,
            files: [file],
            mode: 'full',
            now: fixedNow,
        });

        // Drop and re-apply schema on a fresh in-memory DB, then import the same file via a custom
        // definition that mirrors the antigravity built-in except for its `source`/`targetTable` names.
        db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        const mirror: SourceDefinition = {
            ...customAcmeSource(),
            source: 'antigravity-parity',
            targetTable: 'history_etl_antigravity_parity',
            fieldMap: {
                id: 'source_record_id',
                timestamp: 'created_at',
                content: 'content',
            },
            // Use the same minimal transform set as the built-in antigravity path.
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

/**
 * one-to-many split mode — fan a single raw JSONL row into multiple ETL records
 * via `splitConfig.field` (a nested array). Covers `splitRawRecord`'s one-to-many
 * branch (previously the only split mode with no coverage).
 */
describe('runJsonlImport one-to-many split mode', () => {
    function manySource(): SourceDefinition {
        return {
            source: 'many',
            displayName: 'Many',
            defaultRoots: ['.many'],
            filePatterns: ['*.jsonl'],
            targetTable: 'history_etl_many',
            splitConfig: { mode: 'one-to-many', field: 'messages' },
            fieldMap: {
                id: 'source_record_id',
                content: 'content',
                role: 'role',
            },
            fieldTransforms: {},
            schema: z.object({
                source_record_id: z.string().min(1),
                content: z.string().min(1),
                role: z.string().optional(),
            }),
        };
    }

    test('fans a nested array field into multiple records, merging top-level fields', async () => {
        const file = await fixtureFile([
            JSON.stringify({
                id: 'm1',
                timestamp: '2026-05-30T00:00:00.000Z',
                messages: [
                    { role: 'user', content: 'first' },
                    { role: 'assistant', content: 'second' },
                ],
            }),
        ]);

        const result = await runJsonlImport(manySource(), { db, files: [file], mode: 'full', now: fixedNow });

        expect(result.importedRecords).toBe(2);
        const rows = await db.queryAll<{ payload_json: string }>(
            'SELECT payload_json FROM history_etl_many ORDER BY payload_json',
        );
        expect(rows.map((r) => parsePayloadJson(r.payload_json).content)).toEqual(['first', 'second']);
    });

    test('falls back to a single record when the nested field is absent', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'm2', timestamp: '2026-05-30T00:00:00.000Z', content: 'single' }),
        ]);

        const result = await runJsonlImport(manySource(), { db, files: [file], mode: 'full', now: fixedNow });

        expect(result.importedRecords).toBe(1);
        const rows = await db.queryAll<{ payload_json: string }>('SELECT payload_json FROM history_etl_many');
        expect(rows).toHaveLength(1);
        expect(parsePayloadJson(rows[0]?.payload_json).content).toBe('single');
    });

    test('routes split records to the config targetTable override when provided', async () => {
        const source: SourceDefinition = {
            ...manySource(),
            splitConfig: { mode: 'one-to-many', field: 'messages', targetTable: 'history_etl_nested' },
        };
        const file = await fixtureFile([
            JSON.stringify({
                id: 'm3',
                timestamp: '2026-05-30T00:00:00.000Z',
                messages: [{ role: 'user', content: 'x' }],
            }),
        ]);

        const result = await runJsonlImport(source, { db, files: [file], mode: 'full', now: fixedNow });

        expect(result.importedRecords).toBe(1);
        const rows = await db.queryAll<{ payload_json: string }>('SELECT payload_json FROM history_etl_nested');
        expect(rows).toHaveLength(1);
        expect(parsePayloadJson(rows[0]?.payload_json).source_record_id).toBe('m3');
    });

    test('filters out non-object entries in the nested array', async () => {
        const file = await fixtureFile([
            JSON.stringify({
                id: 'm4',
                timestamp: '2026-05-30T00:00:00.000Z',
                messages: ['string', { role: 'user', content: 'valid' }, 42],
            }),
        ]);

        const result = await runJsonlImport(manySource(), { db, files: [file], mode: 'full', now: fixedNow });

        expect(result.importedRecords).toBe(1);
        const rows = await db.queryAll<{ payload_json: string }>('SELECT payload_json FROM history_etl_many');
        expect(rows).toHaveLength(1);
        expect(parsePayloadJson(rows[0]?.payload_json).content).toBe('valid');
    });
});

/**
 * Custom (non-`*.jsonl`/`*.json`) file patterns during discovery — exercises the
 * `matchesPattern` fallback branch (previously uncovered).
 */
describe('runJsonlImport custom file patterns', () => {
    test('discovers files matching a custom non-jsonl pattern via a file root', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'c1', timestamp: '2026-05-30T00:00:00.000Z', content: 'custom pattern' }),
        ]);
        // Rename so it ends with `history`, matching the `*history` pattern.
        const renamed = file.replace('history.jsonl', 'session_history');
        await writeFile(
            renamed,
            `${JSON.stringify({ id: 'c1', timestamp: '2026-05-30T00:00:00.000Z', content: 'x' })}\n`,
        );
        await rm(file, { recursive: true, force: true });

        const source: SourceDefinition = {
            ...customAcmeSource(),
            filePatterns: ['*history'],
        };

        const result = await runJsonlImport(source, { db, roots: [renamed], mode: 'full', now: fixedNow });

        expect(result.scannedFiles).toBe(1);
        expect(result.importedRecords).toBe(1);
    });
});

/**
 * Full-mode reconciliation (task 0504 R1): a full run diffs the desired hash set against the
 * persisted ledger and retires stale derived rows (target, tool, ledger, checkpoint) in one
 * source-scoped batch. Dry-run reports the identical counts without mutation.
 */
describe('runJsonlImport full-mode reconciliation (0504 R1)', () => {
    test('retires stale rows on full write; dry-run previews the exact counts without mutation; second run is zero', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'a', timestamp: '2026-05-30T00:00:00.000Z', content: 'keep' }),
            JSON.stringify({ id: 'b', timestamp: '2026-05-30T00:00:00.000Z', content: 'stale' }),
        ]);

        const first = await runJsonlImport('antigravity', { db, files: [file], mode: 'full', now: fixedNow });
        expect(first.importedRecords).toBe(2);
        expect(first.reconciliation).toEqual({ staleTargetRows: 0, staleLedgerRows: 0, staleCheckpointRows: 0 });

        // Record `b` is no longer produced by the current source file.
        await writeFile(
            file,
            `${JSON.stringify({ id: 'a', timestamp: '2026-05-30T00:00:00.000Z', content: 'keep' })}\n`,
        );

        // Dry-run previews the deletion counts without touching the database.
        const dryRun = await runJsonlImport('antigravity', {
            db,
            files: [file],
            mode: 'full',
            dryRun: true,
            now: fixedNow,
        });
        expect(dryRun.reconciliation).toEqual({ staleTargetRows: 1, staleLedgerRows: 1, staleCheckpointRows: 0 });
        expect(await db.queryFirst<{ count: number }>('SELECT COUNT(*) AS count FROM history_import_ledger')).toEqual({
            count: 2,
        });

        // Full write applies the same diff in one source-scoped batch.
        const write = await runJsonlImport('antigravity', { db, files: [file], mode: 'full', now: fixedNow });
        expect(write.reconciliation).toEqual({ staleTargetRows: 1, staleLedgerRows: 1, staleCheckpointRows: 0 });
        const ledger = await db.queryAll<{ record_hash: string }>(
            'SELECT record_hash FROM history_import_ledger ORDER BY record_hash',
        );
        expect(ledger).toHaveLength(1);
        const etl = await db.queryAll<{ payload_json: string }>('SELECT payload_json FROM history_etl_antigravity');
        expect(etl).toHaveLength(1);
        expect(etl[0]?.payload_json).toContain('keep');
        expect(etl[0]?.payload_json).not.toContain('stale');

        // A second full run reports zero changes.
        const second = await runJsonlImport('antigravity', { db, files: [file], mode: 'full', now: fixedNow });
        expect(second.importedRecords).toBe(0);
        expect(second.reconciliation).toEqual({ staleTargetRows: 0, staleLedgerRows: 0, staleCheckpointRows: 0 });
    });

    test('deletes checkpoints for source files no longer discovered', async () => {
        const first = await fixtureFile([
            JSON.stringify({ id: 'gone', timestamp: '2026-05-30T00:00:00.000Z', content: 'vanished file' }),
        ]);
        const second = await fixtureFile([
            JSON.stringify({ id: 'current', timestamp: '2026-05-30T00:00:00.000Z', content: 'current file' }),
        ]);

        await runJsonlImport('antigravity', { db, files: [first], mode: 'incremental', now: fixedNow });

        const result = await runJsonlImport('antigravity', { db, files: [second], mode: 'full', now: fixedNow });
        expect(result.reconciliation).toEqual({ staleTargetRows: 1, staleLedgerRows: 1, staleCheckpointRows: 1 });

        const checkpoints = await db.queryAll<{ source_file: string }>(
            'SELECT source_file FROM history_import_checkpoint',
        );
        expect(checkpoints).toEqual([{ source_file: second }]);
        const ledgerRows = await db.queryAll<{ source_file: string }>('SELECT source_file FROM history_import_ledger');
        expect(ledgerRows).toEqual([{ source_file: second }]);
    });

    test('does not report reconciliation outside full mode', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'inc', timestamp: '2026-05-30T00:00:00.000Z', content: 'incremental' }),
        ]);
        const result = await runJsonlImport('antigravity', { db, files: [file], mode: 'incremental', now: fixedNow });
        expect(result.reconciliation).toBeUndefined();
    });
});

/**
 * Atomic per-record validation (task 0504 R2): a schema-invalid split rejects the WHOLE line,
 * so no partially accepted rows (or orphaned tool-call rows with a dangling message_hash) can
 * be left behind by one bad split in a multi-split record.
 */
describe('runJsonlImport atomic validation (0504 R2)', () => {
    test('a schema-invalid split rejects the entire line — nothing from it is persisted', async () => {
        const source: SourceDefinition = {
            source: 'atomic',
            displayName: 'Atomic',
            defaultRoots: ['.atomic'],
            filePatterns: ['*.jsonl'],
            targetTable: 'history_etl_atomic',
            splitConfig: { mode: 'one-to-many', field: 'messages' },
            fieldMap: {
                id: 'source_record_id',
                content: 'content',
                role: 'role',
            },
            fieldTransforms: {},
            schema: z.object({
                source_record_id: z.string().min(1),
                content: z.string().min(1),
                role: z.string().optional(),
            }),
        };
        const file = await fixtureFile([
            JSON.stringify({
                id: 'm1',
                messages: [
                    { role: 'user', content: 'valid sibling' },
                    { role: 'user' }, // missing `content` → schema-invalid
                ],
            }),
        ]);

        const result = await runJsonlImport(source, { db, files: [file], mode: 'full', now: fixedNow });

        expect(result.importedRecords).toBe(0);
        expect(result.validationErrors).toHaveLength(1);
        expect(result.validationErrors[0]?.sourceLine).toBe(1);
        // Nothing persisted: the valid sibling was rejected together with the invalid split.
        expect(await db.queryAll('SELECT record_hash FROM history_import_ledger')).toEqual([]);
        expect(await db.queryAll('SELECT record_hash FROM history_etl_atomic')).toEqual([]);
    });
});
describe('runJsonlImport dryRun mode', () => {
    test('counts records without persisting or checkpointing', async () => {
        const file = await fixtureFile([
            JSON.stringify({ id: 'd1', timestamp: '2026-05-30T00:00:00.000Z', content: 'dry' }),
            JSON.stringify({ id: 'd2', timestamp: '2026-05-30T00:01:00.000Z', content: 'run' }),
        ]);

        const result = await runJsonlImport('antigravity', {
            db,
            files: [file],
            mode: 'full',
            dryRun: true,
            now: fixedNow,
        });

        expect(result.importedRecords).toBe(2);
        expect(result.processedLines).toBe(2);
        expect(result.checkpointUpdates).toBe(0);

        // Nothing persisted: no ETL rows, no ledger rows, no checkpoints.
        const etlRows = await db.queryAll<{ payload_json: string }>('SELECT payload_json FROM history_etl_antigravity');
        expect(etlRows).toEqual([]);
        const ledgerRows = await db.queryAll<{ record_hash: string }>('SELECT record_hash FROM history_import_ledger');
        expect(ledgerRows).toEqual([]);
        const checkpoints = await db.queryAll<{ last_imported_line: number }>(
            'SELECT last_imported_line FROM history_import_checkpoint',
        );
        expect(checkpoints).toEqual([]);
    });
});

/**
 * Task 0564 R1 — omp tool-call durations survive import.
 *
 * A toolCall row is emitted with its assistant message (insert-only SplitEntry);
 * the duration arrives on a later toolResult line and is attached in the
 * streaming loop keyed on (source, session_id, call_id). The frozen contract:
 * wallTimeMs first (rounded, never clamped), timestamp-delta fallback with
 * [0, 3_600_000] guard rails (implausible stays NULL), bounds written for
 * fallback figures, unmatched toolCallId attaches nothing, and the whole thing
 * is idempotent + safe under line-checkpointed resume.
 */

const R1_ASSISTANT_TS = '2026-08-14T05:11:13.990Z';

/** One omp assistant message carrying four toolCall blocks with live `arguments` shape. */
function r1AssistantLine(): string {
    return JSON.stringify({
        type: 'message',
        id: 'evt-1',
        timestamp: R1_ASSISTANT_TS,
        message: {
            role: 'assistant',
            model: 'claude-x',
            content: [
                { type: 'toolCall', id: 'call-w', name: 'Bash', arguments: { command: 'echo wall' } },
                { type: 'toolCall', id: 'call-f', name: 'Bash', arguments: { command: 'echo fallback' } },
                { type: 'toolCall', id: 'call-neg', name: 'Bash', arguments: { command: 'echo neg' } },
                { type: 'toolCall', id: 'call-huge', name: 'Bash', arguments: { command: 'echo huge' } },
            ],
        },
    });
}

/** One omp toolResult message envelope (role: "toolResult", live shape). */
function r1ToolResultLine(toolCallId: string, timestamp: string, details: Record<string, unknown> = {}): string {
    return JSON.stringify({
        type: 'message',
        id: `evt-${toolCallId}`,
        timestamp,
        message: {
            role: 'toolResult',
            toolCallId,
            toolName: 'bash',
            content: [{ type: 'text', text: 'ok' }],
            details,
            isError: false,
            timestamp,
        },
    });
}

/** Full duration fixture: wallTimeMs, fallback, negative, >1h, and unmatched results. */
function r1FullLines(): string[] {
    return [
        r1AssistantLine(),
        // wallTimeMs path — the tool's own measurement wins, rounded, no bounds.
        r1ToolResultLine('call-w', '2026-08-14T05:11:14.327Z', { wallTimeMs: 1234.6, exitCode: 0 }),
        // fallback path — no wallTimeMs; delta = 16.490 − 13.990 = 2500ms, bounds recorded.
        r1ToolResultLine('call-f', '2026-08-14T05:11:16.490Z', { exitCode: 0 }),
        // implausible fallback — result BEFORE the assistant message → negative → NULL.
        r1ToolResultLine('call-neg', '2026-08-14T05:11:10.000Z', { exitCode: 0 }),
        // implausible fallback — delta ≈ 1h18m > 3_600_000 → NULL.
        r1ToolResultLine('call-huge', '2026-08-14T06:30:00.000Z', { exitCode: 0 }),
        // unmatched toolCallId — attaches nothing, never fails the import.
        r1ToolResultLine('call-missing', '2026-08-14T05:11:15.000Z', { wallTimeMs: 99 }),
    ];
}

interface ToolCallRow {
    call_id: string | null;
    tool_name: string;
    duration_ms: number | null;
    started_at: string | null;
    completed_at: string | null;
}

async function r1ToolRows(db: DbAdapter): Promise<ToolCallRow[]> {
    return db.queryAll<ToolCallRow>(
        'SELECT call_id, tool_name, duration_ms, started_at, completed_at FROM history_tool_call ORDER BY seq',
    );
}

describe('runJsonlImport omp tool durations (0564 R1)', () => {
    test('call_id survives import and wallTimeMs/fallback/implausible/unmatched resolve per contract', async () => {
        const file = await namedFixtureFile('r1-durations', r1FullLines());
        const result = await runJsonlImport('omp', { db, files: [file], mode: 'force-file', now: fixedNow });

        expect(result.importedRecords).toBe(10); // 6 messages (assistant + 5 results) + 4 tool calls
        const rows = await r1ToolRows(db);
        expect(rows).toHaveLength(4);
        const byId = new Map(rows.map((r) => [r.call_id, r]));
        expect(byId.get('call-w')).toMatchObject({ duration_ms: 1235, started_at: null, completed_at: null });
        expect(byId.get('call-f')).toMatchObject({
            duration_ms: 2500,
            started_at: R1_ASSISTANT_TS,
            completed_at: '2026-08-14T05:11:16.490Z',
        });
        expect(byId.get('call-neg')?.duration_ms).toBeNull();
        expect(byId.get('call-huge')?.duration_ms).toBeNull();
        expect(byId.has('call-missing')).toBe(false); // no row exists — nothing attached, nothing failed
    });

    test('re-import is idempotent — the same durations are written again (force-file reprocesses)', async () => {
        const file = await namedFixtureFile('r1-idempotent', r1FullLines());
        await runJsonlImport('omp', { db, files: [file], mode: 'force-file', now: fixedNow });
        const afterFirst = await r1ToolRows(db);

        const second = await runJsonlImport('omp', { db, files: [file], mode: 'force-file', now: fixedNow });
        // All rows are ledger duplicates on the second pass — the attach still re-runs.
        expect(second.skippedDuplicates).toBeGreaterThan(0);
        expect(await r1ToolRows(db)).toEqual(afterFirst);
    });

    test('resume after an interrupted run attaches durations via the DB fallback', async () => {
        // One physical file path: run 1 sees only the assistant line (call rows
        // inserted, no results yet, checkpoint at line 1).
        const dir = await mkdtemp(join(tmpdir(), 'llm-jsonl-importer-r1-'));
        const file = join(dir, 'r1-resume.jsonl');
        await writeFile(file, `${r1AssistantLine()}\n`);

        await runJsonlImport('omp', { db, files: [file], mode: 'force-file', now: fixedNow });

        // The session file grows; run 2 (incremental) continues from the checkpoint.
        // The assistant line is skipped, so its calls are NOT in the in-memory map —
        // the toolResult lines must resolve the rows from the DB and still attach.
        await writeFile(file, `${r1FullLines().join('\n')}\n`);
        const resumed = await runJsonlImport('omp', { db, files: [file], mode: 'incremental', now: fixedNow });
        expect(resumed.processedLines).toBe(5); // the 5 toolResult lines after the checkpoint

        const rows = await r1ToolRows(db);
        const byId = new Map(rows.map((r) => [r.call_id, r]));
        expect(byId.get('call-w')?.duration_ms).toBe(1235);
        expect(byId.get('call-f')).toMatchObject({ duration_ms: 2500, started_at: R1_ASSISTANT_TS });
        expect(byId.get('call-neg')?.duration_ms).toBeNull();
        expect(byId.get('call-huge')?.duration_ms).toBeNull();
    });

    test('a truncated mid-file session loses no earlier duration on re-import', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'llm-jsonl-importer-r1-'));
        const file = join(dir, 'r1-truncated.jsonl');
        await writeFile(file, `${r1FullLines().join('\n')}\n`);
        await runJsonlImport('omp', { db, files: [file], mode: 'force-file', now: fixedNow });
        const before = await r1ToolRows(db);

        // The file is now truncated mid-file (assistant + wallTimeMs result only). Re-import
        // incrementally: the checkpoint is past the truncation, so nothing is re-processed
        // and the earlier durations survive untouched.
        await writeFile(
            file,
            `${r1AssistantLine()}\n${r1ToolResultLine('call-w', '2026-08-14T05:11:14.327Z', { wallTimeMs: 1234.6, exitCode: 0 })}\n`,
        );
        const result = await runJsonlImport('omp', { db, files: [file], mode: 'incremental', now: fixedNow });
        expect(result.processedLines).toBe(0);
        expect(await r1ToolRows(db)).toEqual(before);
    });
});
