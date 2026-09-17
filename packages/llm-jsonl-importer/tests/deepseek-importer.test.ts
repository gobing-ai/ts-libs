import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDbAdapter, type DbAdapter } from '@gobing-ai/ts-db';
import type { RuntimePaths } from '@gobing-ai/ts-runtime';
import { getEnvVar, removeEnvVar, setEnvVar } from '@gobing-ai/ts-utils';
import { getSourceDefinition, HistoryImportError, runJsonlImport, VALID_TABLE_NAME, zstdDecompress } from '../src';
import { dshSplit } from '../src/mappers';
import type { JsonObject } from '../src/types';

let db: DbAdapter;
let root: string;
const UUID = '3d2b7a1e-1111-4222-8333-444455556666';
let savedDshHome: string | undefined;

beforeEach(async () => {
    db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
    root = await mkdtemp(join(tmpdir(), 'dsh-test-'));
    // Isolation: $DSH_HOME leaks from the operator shell into the full-suite run and
    // repoints discovery at the real ~/.dsh sessions (scannedFiles 5 vs fixture 2/1).
    savedDshHome = getEnvVar('DSH_HOME');
    removeEnvVar('DSH_HOME');
});

afterEach(async () => {
    setEnvVar('DSH_HOME', savedDshHome);

    await rm(root, { recursive: true, force: true });
});

/** Fixture event lines: header + user message + assistant message + unrelated event + torn tail. */
function fixtureLines(): string[] {
    return [
        JSON.stringify({
            type: 'session',
            version: 3,
            id: UUID,
            createdAt: '2026-09-11T22:00:00.000Z',
            cwd: root,
            isSeeded: false,
        }),
        JSON.stringify({
            type: 'user/message',
            seq: 1,
            time: 1726088422000,
            data: { message: { role: 'user', id: 'm-1', content: [{ type: 'text', text: 'hi there' }] } },
        }),
        JSON.stringify({
            type: 'assistant/message',
            seq: 2,
            time: 1726088423000,
            data: {
                message: {
                    role: 'assistant',
                    id: 'm-2',
                    content: [
                        { type: 'text', text: 'hello' },
                        { type: 'text', text: 'world' },
                    ],
                    source: { provider: 'deepseek', model: 'deepseek-v3' },
                    usage: { input_tokens: 10, output_tokens: 5 },
                },
            },
        }),
        JSON.stringify({ type: 'turn/start', seq: 3, time: 1726088423500, data: {} }),
        '{"type":"user/message","seq":4,"time":1726088424',
    ];
}

/** Write the fixture under `home/.dsh/sessions/--cwd--/session-<uuid>/`, optionally compressed. */
async function writeSession(uncompressed: boolean, overrideRoot?: string): Promise<string> {
    const sessionsRoot = overrideRoot !== undefined ? overrideRoot : join(root, '.dsh', 'sessions');
    const dir = join(sessionsRoot, '--tmp--proj--', `session-${UUID}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, uncompressed ? 'session.v3.jsonl' : 'session.v3.jsonl.zstd');
    const raw = fixtureLines().join('\n');
    if (!uncompressed) {
        const scratch = join(root, 'plain.jsonl');
        await writeFile(scratch, raw);
        const proc = Bun.spawnSync(['zstd', '-q', '-f', '-o', file, scratch]);
        if (proc.exitCode !== 0) throw new Error(`zstd fixture compression failed: ${proc.stderr.toString()}`);
        await rm(scratch);
    } else {
        await writeFile(file, raw);
    }
    return file;
}

interface MessageRow {
    [key: string]: unknown;
}

/** Typed history_message columns for one source's import (ordered by insert). */
const messageRows = async (
    target: DbAdapter,
    columns: string = 'record_hash, disposition, session_id, seq, role, record_type, ts, model, input_tokens, output_tokens, content_text, provenance',
): Promise<MessageRow[]> => {
    const rows = await target.queryAll<Record<string, unknown>>(
        `SELECT ${columns} FROM history_message ORDER BY rowid`,
    );
    return rows as MessageRow[];
};

describe('deepseek importer (task 0067)', () => {
    test('R1 — discovery finds session.v3.jsonl and .zstd under home .dsh/sessions', async () => {
        await writeSession(false);
        await writeSession(true);
        const result = await runJsonlImport('deepseek', {
            db,
            mode: 'full',
            paths: { home: root, cwd: root } satisfies RuntimePaths,
        });
        expect(result.scannedFiles).toBe(2);
    });

    test('R1 — $DSH_HOME home-relative import resolves the sessions dir under an injected home', async () => {
        await writeSession(true);
        // DSH root override: <DSH_HOME>/sessions, so point it at the fixture's .dsh dir.
        setEnvVar('DSH_HOME', join(root, '.dsh'));
        const result = await runJsonlImport('deepseek', {
            db,
            mode: 'full',
            paths: { home: root, cwd: root } satisfies RuntimePaths,
        });
        expect(result.scannedFiles).toBe(1);
        expect(result.importedRecords).toBe(3);
    });

    test('R5 — zstd session log imports: header is bookkeeping, messages mapped', async () => {
        const file = await writeSession(false);
        const result = await runJsonlImport('deepseek', { db, files: [file], mode: 'full' });

        expect(result.importedRecords).toBe(3); // header meta + user + assistant
        expect(result.parseErrors).toHaveLength(0);
        const records = await messageRows(db);
        const messages = records.filter((row) => row.disposition === 'keep');
        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatchObject({
            session_id: UUID,
            seq: 1,
            role: 'user',
            record_type: 'user/message',
            ts: new Date(1726088422000).toISOString(),
            content_text: 'hi there',
        });
        expect(messages[1]).toMatchObject({
            seq: 2,
            role: 'assistant',
            model: 'deepseek-v3',
            input_tokens: 10,
            output_tokens: 5,
            content_text: 'hello\nworld',
        });
    });

    test('R6 — the same fixture uncompressed maps to identical records except storage artifacts', async () => {
        const zstdFile = await writeSession(false);
        await runJsonlImport('deepseek', { db, files: [zstdFile], mode: 'full' });
        const zstdRecords = await messageRows(
            db,
            'disposition, session_id, seq, role, record_type, ts, model, input_tokens, output_tokens, content_text',
        );

        const dbRaw: DbAdapter = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        const rawFile = await writeSession(true);
        const rawResult = await runJsonlImport('deepseek', { db: dbRaw, files: [rawFile], mode: 'full' });
        expect(rawResult.importedRecords).toBe(3);
        const rawRecords = await messageRows(
            dbRaw,
            'disposition, session_id, seq, role, record_type, ts, model, input_tokens, output_tokens, content_text',
        );

        const stripStorage = (record: JsonObject): JsonObject => {
            const { source, source_file, source_line, split_index, ...rest } = record as Record<string, unknown>;
            return rest;
        };
        expect(zstdRecords.map(stripStorage)).toEqual(rawRecords.map(stripStorage));
    });

    test('R4 — torn tail and unknown event types do not abort the import', async () => {
        const file = await writeSession(true);
        const result = await runJsonlImport('deepseek', { db, files: [file], mode: 'full' });

        expect(result.importedRecords).toBe(3);
        expect(result.skippedCorruptLines).toBe(1);
        expect(result.parseErrors).toHaveLength(0);
        expect(result.validationErrors).toHaveLength(0);
    });

    test('R8 — missing zstd executable fails with an actionable error naming zstd and the file', async () => {
        const file = await writeSession(false);
        await expect(zstdDecompress(file, { PATH: '/nonexistent-dsh-path' })).rejects.toThrow(HistoryImportError);
        await expect(zstdDecompress(file, { PATH: '/nonexistent-dsh-path' })).rejects.toThrow(
            /zstd executable is required on PATH/,
        );
        await expect(zstdDecompress(file, { PATH: '/nonexistent-dsh-path' })).rejects.toThrow(
            new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        );
    });

    test('R2 — message id (data.message.id) is honored as source_record_id in the mapper', () => {
        const entries = dshSplit({
            type: 'user/message',
            seq: 1,
            time: 1726088422000,
            data: { message: { role: 'user', id: 'm-1', content: [{ type: 'text', text: 'hi there' }] } },
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.record.source_record_id).toBe('m-1');
    });

    test('R2 — absent message id falls back: no source_record_id key, line-hash identity unchanged', () => {
        const entries = dshSplit({
            type: 'assistant/message',
            seq: 2,
            time: 1726088423000,
            data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
        });
        expect(entries).toHaveLength(1);
        expect('source_record_id' in (entries[0]?.record ?? {})).toBe(false);
    });

    test('R9 — registry entry is wired under the deepseek source key', () => {
        const definition = getSourceDefinition('deepseek');
        expect(definition.defaultRoots).toEqual(['.dsh/sessions']);
        expect(definition.filePatterns).toEqual(['session.v3.jsonl', 'session.v3.jsonl.zstd']);
        expect(definition.targetTable).toBe('history_etl_deepseek');
        expect(VALID_TABLE_NAME.test(definition.targetTable)).toBe(true);
        expect(definition.corruptLinePolicy).toBe('skip');
        expect(definition.splitConfig.mode).toBe('custom');
    });
});
