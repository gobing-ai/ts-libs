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

/**
 * task 1471: dsh 0.2.2-rc.1 writes `session.v4.jsonl[.zstd]`. The header and message envelopes keep
 * their v3 shape (`type`, `data.message`).
 */
function fixtureV4Lines(): string[] {
    return fixtureLines().map((line) => {
        if (line.startsWith('{"type":"session"')) {
            return line
                .replace('"version":3', '"version":4')
                .replace('"createdAt":"2026-09-11T22:00:00.000Z"', '"createdAt":1795501024185');
        }
        if (line.startsWith('{"type":"assistant/message"')) {
            const event = JSON.parse(line);
            event.data.message.content.push({
                type: 'tool-call',
                id: 'c-1',
                name: 'read',
                arguments: '{"file":"fixture"}',
            });
            return JSON.stringify(event);
        }
        return line;
    });
}

/** Write the v4 fixture beside the v3 layout, optionally zstd-compressed. */
async function writeV4Session(uncompressed: boolean): Promise<string> {
    const dir = join(root, '.dsh', 'sessions', '--tmp--proj--', `session-${UUID}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, uncompressed ? 'session.v4.jsonl' : 'session.v4.jsonl.zstd');
    const raw = fixtureV4Lines().join('\n');
    if (!uncompressed) {
        const scratch = join(root, 'plain-v4.jsonl');
        await writeFile(scratch, raw);
        const proc = Bun.spawnSync(['zstd', '-q', '-f', '-o', file, scratch]);
        if (proc.exitCode !== 0) throw new Error(`zstd fixture compression failed: ${proc.stderr.toString()}`);
        await rm(scratch);
    } else {
        await writeFile(file, raw);
    }
    return file;
}

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
        // The fixture's final line is an unterminated torn tail: since the incomplete-tail
        // fix it is exempted as a write in progress (re-read next run), not counted as a
        // policy-skipped corrupt line.
        expect(result.skippedCorruptLines).toBe(0);
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
        expect(definition.filePatterns).toEqual([
            'session.v3.jsonl',
            'session.v3.jsonl.zstd',
            'session.v4.jsonl',
            'session.v4.jsonl.zstd',
        ]);
        expect(definition.targetTable).toBe('history_etl_deepseek');
        expect(VALID_TABLE_NAME.test(definition.targetTable)).toBe(true);
        expect(definition.corruptLinePolicy).toBe('skip');
        expect(definition.splitConfig.mode).toBe('custom');
    });
});

describe('deepseek v4 sessions (task 1471, feature E11)', () => {
    test('discovery finds session.v4.jsonl and .zstd under home .dsh/sessions', async () => {
        await writeV4Session(true);
        await writeV4Session(false);
        const result = await runJsonlImport('deepseek', {
            db,
            mode: 'full',
            paths: { home: root, cwd: root } satisfies RuntimePaths,
        });
        expect(result.scannedFiles).toBe(2);
    });

    test('a v4 session maps its header and messages through dshSplit', async () => {
        const file = await writeV4Session(true);
        const result = await runJsonlImport('deepseek', { db, files: [file], mode: 'full' });
        expect(result.parseErrors).toHaveLength(0);
        const records = await messageRows(db);
        const messages = records.filter((row) => row.disposition === 'keep');
        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatchObject({ session_id: UUID, role: 'user', content_text: 'hi there' });
    });

    test('a compressed v4 session imports too, and its torn tail is skipped', async () => {
        const compressed = await writeV4Session(false);
        expect(compressed.endsWith('.jsonl.zstd')).toBe(true);
        const result = await runJsonlImport('deepseek', { db, files: [compressed], mode: 'full' });
        expect(result.parseErrors).toHaveLength(0);
        expect(result.importedRecords).toBeGreaterThan(0);
    });

    test('a v4 tool invocation is attributed to deepseek and linked to its assistant message', async () => {
        const file = await writeV4Session(true);
        await runJsonlImport('deepseek', { db, files: [file], mode: 'full' });
        await runJsonlImport('deepseek', { db, files: [file], mode: 'full' });
        const rows = await db.queryAll(
            `SELECT t.source, t.session_id, t.call_id, t.tool_name, t.status, m.role
             FROM history_tool_call t JOIN history_message m ON m.record_hash = t.message_hash`,
        );
        expect(rows).toEqual([
            {
                source: 'deepseek',
                session_id: UUID,
                call_id: 'c-1',
                tool_name: 'read',
                status: 'unknown',
                role: 'assistant',
            },
        ]);
    });
});
