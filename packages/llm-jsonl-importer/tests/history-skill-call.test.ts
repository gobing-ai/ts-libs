import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDbAdapter, type DbAdapter } from '@gobing-ai/ts-db';
import { runJsonlImport, type SkillCall } from '../src';
import { applyHistoryImportSchema, insertRecord } from '../src/jsonl-importer-dao';

const fixedNow = () => new Date('2026-08-07T00:00:00.000Z');

/** Well-formed skill-load record: payload keyed exactly by column names. */
function skillCall(overrides: Partial<Omit<SkillCall, 'imported_at'>> = {}): SkillCall {
    return {
        record_hash: 'hash-1',
        message_hash: 'msg-1',
        source: 'claude',
        source_file: '/tmp/history.jsonl',
        source_line: 1,
        session_id: 'session-1',
        seq: 0,
        skill_name: 'sp:dev-run',
        invocation_kind: 'user',
        imported_at: '',
        ...overrides,
    };
}

/** Minimal valid claude fixture line with no skill activity. */
function claudeLine(): string {
    return JSON.stringify({ id: 'plain-1', timestamp: '2026-05-30T00:00:00.000Z', content: 'no skills here' });
}

beforeEach(async () => {
    db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
});

let db: DbAdapter;

describe('history_skill_call schema (0735 AC1)', () => {
    test('applying the import schema creates every column and index', async () => {
        await applyHistoryImportSchema(db);

        const columns = await db.queryAll<{ name: string; notnull: number }>('PRAGMA table_info(history_skill_call)');
        expect(new Map(columns.map((c) => [c.name, c.notnull]))).toEqual(
            new Map([
                // record_hash is TEXT PRIMARY KEY: SQLite reports notnull=0 (uniqueness comes
                // from the PK index, not a NOT NULL constraint) — same as history_tool_call.
                ['record_hash', 0],
                ['message_hash', 1],
                ['source', 1],
                ['source_file', 1],
                ['source_line', 1],
                ['session_id', 1],
                ['seq', 1],
                ['skill_name', 1],
                ['invocation_kind', 1],
                ['skill_path', 0],
                ['args_raw', 0],
                ['args_digest', 0],
                ['call_id', 0],
                ['status', 0],
                ['started_at', 0],
                ['completed_at', 0],
                ['duration_ms', 0],
                ['imported_at', 1],
                // E93 1028 capability facts — every one nullable.
                ['capability_kind', 0],
                ['evidence_kind', 0],
                ['invocation_id', 0],
                ['origin_identity', 0],
            ]),
        );

        const indexes = await db.queryAll<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'history_skill_call' " +
                "AND name NOT LIKE 'sqlite_%' ORDER BY name",
        );
        expect(indexes.map((i) => i.name)).toEqual([
            'idx_history_skill_call_invocation_kind',
            'idx_history_skill_call_message_hash',
            'idx_history_skill_call_session',
            'idx_history_skill_call_skill_name',
        ]);
    });

    test('invocation_kind is constrained to user|model and re-apply is idempotent (0735 R5)', async () => {
        await applyHistoryImportSchema(db);
        const record = skillCall();
        await insertRecord(
            db,
            'history_skill_call',
            record.record_hash,
            record.source_file,
            record.source_line,
            0,
            {
                ...record,
                imported_at: undefined,
            },
            fixedNow,
        );

        await applyHistoryImportSchema(db);

        const rows = await db.queryAll<{ skill_name: string; invocation_kind: string }>(
            'SELECT skill_name, invocation_kind FROM history_skill_call',
        );
        expect(rows).toEqual([{ skill_name: 'sp:dev-run', invocation_kind: 'user' }]);

        const bad: Record<string, unknown> = {
            ...skillCall({ record_hash: 'hash-bad' }),
            invocation_kind: 'agent',
        };
        expect(
            insertRecord(db, 'history_skill_call', 'hash-bad', '/tmp/history.jsonl', 1, 0, bad, fixedNow),
        ).rejects.toThrow();
    });
});

describe('history_skill_call capability columns (E93 1028)', () => {
    /** Recreate the pre-1028 table shape (no capability columns). */
    async function createLegacySchema(): Promise<void> {
        for (const statement of `
            CREATE TABLE history_import_checkpoint (
                source TEXT NOT NULL,
                source_file TEXT NOT NULL,
                last_imported_line INTEGER NOT NULL,
                PRIMARY KEY (source, source_file)
            );
            CREATE TABLE history_import_ledger (
                record_hash TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                source_file TEXT NOT NULL,
                source_line INTEGER NOT NULL,
                split_index INTEGER NOT NULL,
                target_table TEXT NOT NULL,
                imported_at TEXT NOT NULL
            );
            CREATE TABLE history_skill_call (
                record_hash     TEXT PRIMARY KEY,
                message_hash    TEXT NOT NULL,
                source          TEXT NOT NULL,
                source_file     TEXT NOT NULL,
                source_line     INTEGER NOT NULL,
                session_id      TEXT NOT NULL,
                seq             INTEGER NOT NULL,
                skill_name      TEXT NOT NULL,
                invocation_kind TEXT NOT NULL CHECK (invocation_kind IN ('user', 'model')),
                skill_path      TEXT,
                args_raw        TEXT,
                args_digest     TEXT,
                call_id         TEXT,
                status          TEXT,
                started_at      TEXT,
                completed_at    TEXT,
                duration_ms     REAL,
                imported_at     TEXT NOT NULL
            );
        `.split(';')) {
            const sql = statement.trim();
            if (sql.length > 0) await db.exec(sql);
        }
    }

    test('standalone upgrade adds only the missing capability columns, in canonical order', async () => {
        await createLegacySchema();
        await db.exec(
            `INSERT INTO history_skill_call (record_hash, message_hash, source, source_file, source_line, session_id, seq, skill_name, invocation_kind, imported_at)
             VALUES ('legacy-1', 'msg-legacy', 'claude', '/tmp/h.jsonl', 1, 's-1', 0, 'old-skill', 'user', '2026-01-01T00:00:00.000Z')`,
        );

        await applyHistoryImportSchema(db);

        const columns = await db.queryAll<{ name: string }>('PRAGMA table_info(history_skill_call)');
        expect(columns.map((c) => c.name).slice(-4)).toEqual([
            'capability_kind',
            'evidence_kind',
            'invocation_id',
            'origin_identity',
        ]);
        // Legacy rows keep NULL capability facts; identity columns are untouched.
        const legacy = await db.queryFirst<Record<string, unknown>>(
            'SELECT capability_kind, evidence_kind, invocation_id, origin_identity, skill_name FROM history_skill_call WHERE record_hash = ?',
            'legacy-1',
        );
        expect(legacy).toEqual({
            capability_kind: null,
            evidence_kind: null,
            invocation_id: null,
            origin_identity: null,
            skill_name: 'old-skill',
        });

        // Re-apply is idempotent and new inserts use the upgraded shape.
        await applyHistoryImportSchema(db);
        const record = skillCall({
            record_hash: 'post-upgrade',
            capability_kind: 'skill',
            evidence_kind: 'load',
            invocation_id: 'inv-1',
            origin_identity: 'sp/src/skills/dev-run',
        });
        await insertRecord(
            db,
            'history_skill_call',
            record.record_hash,
            record.source_file,
            record.source_line,
            0,
            { ...record, imported_at: undefined },
            fixedNow,
        );
        const upgraded = await db.queryFirst<Record<string, unknown>>(
            'SELECT capability_kind, evidence_kind, invocation_id, origin_identity FROM history_skill_call WHERE record_hash = ?',
            'post-upgrade',
        );
        expect(upgraded).toEqual({
            capability_kind: 'skill',
            evidence_kind: 'load',
            invocation_id: 'inv-1',
            origin_identity: 'sp/src/skills/dev-run',
        });
    });

    test('ensureSkillCallCapabilityColumns is a no-op when the table is absent', async () => {
        // No DDL applied at all: the guarded upgrade must not fail; the DDL path creates the table.
        await applyHistoryImportSchema(db);
        const columns = await db.queryAll<{ name: string }>('PRAGMA table_info(history_skill_call)');
        expect(columns.map((c) => c.name)).toContain('capability_kind');
    });
});

describe('history_skill_call typed insert path (0735 AC4)', () => {
    test('well-formed SkillCall round-trips through the DAO typed-column insert', async () => {
        await applyHistoryImportSchema(db);
        const record = skillCall({
            skill_path: '/skills/sp/dev-run/SKILL.md',
            args_raw: '{"wbs":"0735"}',
            args_digest: 'digest-1',
            call_id: 'call-1',
            status: 'ok',
            started_at: '2026-05-30T00:00:00.000Z',
            completed_at: '2026-05-30T00:00:01.000Z',
            duration_ms: 1000.5,
        });

        await insertRecord(
            db,
            'history_skill_call',
            record.record_hash,
            record.source_file,
            record.source_line,
            0,
            {
                ...record,
                imported_at: undefined,
            },
            fixedNow,
        );

        const rows = await db.queryAll<Record<string, unknown>>('SELECT * FROM history_skill_call');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            record_hash: 'hash-1',
            message_hash: 'msg-1',
            source: 'claude',
            session_id: 'session-1',
            seq: 0,
            skill_name: 'sp:dev-run',
            invocation_kind: 'user',
            skill_path: '/skills/sp/dev-run/SKILL.md',
            args_raw: '{"wbs":"0735"}',
            args_digest: 'digest-1',
            call_id: 'call-1',
            status: 'ok',
            duration_ms: 1000.5,
            imported_at: '2026-08-07T00:00:00.000Z',
        });
    });

    test('insert missing skill_name is rejected by the NOT NULL constraint', async () => {
        await applyHistoryImportSchema(db);
        const record: Record<string, unknown> = { ...skillCall({ record_hash: 'hash-null-name' }) };
        delete record.skill_name;
        expect(
            insertRecord(db, 'history_skill_call', 'hash-null-name', '/tmp/history.jsonl', 1, 0, record, fixedNow),
        ).rejects.toThrow(/NOT NULL/);
    });

    test('unknown payload keys are rejected by the typed column map', async () => {
        await applyHistoryImportSchema(db);
        const record: Record<string, unknown> = { ...skillCall(), not_a_column: 'x' };
        record.not_a_column = 'x';
        expect(
            insertRecord(db, 'history_skill_call', 'hash-x', '/tmp/history.jsonl', 1, 0, record, fixedNow),
        ).rejects.toThrow(/unknown columns/);
    });
});

describe('history_skill_call lazy creation (0735 AC2/R6)', () => {
    test('import with zero skill activity completes and leaves an empty created table', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'llm-jsonl-importer-0735-'));
        try {
            const file = join(directory, 'history.jsonl');
            await writeFile(file, `${claudeLine()}\n`);
            const discovered = await realpath(file);

            const result = await runJsonlImport('claude', { db, files: [discovered], mode: 'full', now: fixedNow });
            expect(result.importedRecords).toBe(1);
            expect(result.validationErrors).toHaveLength(0);
            expect(result.parseErrors).toHaveLength(0);

            const tables = await db.queryAll<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'history_skill_call'",
            );
            expect(tables).toHaveLength(1);
            const rows = await db.queryAll<{ count: number }>('SELECT COUNT(*) AS count FROM history_skill_call');
            expect(rows[0]?.count).toBe(0);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
