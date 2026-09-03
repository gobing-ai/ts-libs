import { describe, expect, test } from 'bun:test';
import { createDbAdapter, type DbAdapter } from '@gobing-ai/ts-db';
import {
    DERIVED_DURATION_CEILING_MS,
    DURATION_SOURCE_DERIVED,
    deriveAssistantDurations,
} from '../src/assistant-duration';
import { applyHistoryImportSchema } from '../src/jsonl-importer-dao';

/**
 * Task 0747 / 0702 R2 — the ETL fills assistant-step duration the sources never wrote.
 * Sourced directly from the schema applied by the importer.
 */

async function setup(): Promise<DbAdapter> {
    const db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
    await applyHistoryImportSchema(db);
    return db;
}

interface Row {
    hash: string;
    seq: number;
    role: string;
    ts: string | null;
    durationMs?: number | null;
    session?: string;
}

async function insert(db: DbAdapter, row: Row): Promise<void> {
    await db.run(
        `INSERT INTO history_message (record_hash, source, source_file, source_line, session_id, seq,
             role, record_type, disposition, ts, duration_ms, provenance, imported_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        row.hash,
        'claude',
        'f.jsonl',
        row.seq,
        row.session ?? 'sess-1',
        row.seq,
        row.role,
        'message',
        'kept',
        row.ts,
        row.durationMs ?? null,
        'ambient',
        '2026-08-28T00:00:00.000Z',
    );
}

async function read(
    db: DbAdapter,
    hash: string,
): Promise<{ duration_ms: number | null; duration_source: string | null }> {
    const row = await db.queryFirst<{ duration_ms: number | null; duration_source: string | null }>(
        'SELECT duration_ms, duration_source FROM history_message WHERE record_hash = ?',
        hash,
    );
    return row ?? { duration_ms: null, duration_source: null };
}

describe('deriveAssistantDurations (repatriated 0747)', () => {
    test('fills an unmeasured assistant step from the delta to the preceding record', async () => {
        expect(DURATION_SOURCE_DERIVED).toBe('derived');
        const db = await setup();
        await insert(db, { hash: 'u1', seq: 1, role: 'user', ts: '2026-08-28T10:00:00.000Z' });
        await insert(db, { hash: 'a1', seq: 2, role: 'assistant', ts: '2026-08-28T10:00:04.500Z' });

        const result = await deriveAssistantDurations(db);

        expect(result.derived).toBe(1);
        expect(await read(db, 'a1')).toEqual({ duration_ms: 4500, duration_source: 'derived' });
    });

    test('never overwrites a provider-reported duration', async () => {
        const db = await setup();
        await insert(db, { hash: 'u1', seq: 1, role: 'user', ts: '2026-08-28T10:00:00.000Z' });
        await insert(db, { hash: 'a1', seq: 2, role: 'assistant', ts: '2026-08-28T10:00:09.000Z', durationMs: 1234 });

        const result = await deriveAssistantDurations(db);

        expect(result.derived).toBe(0);
        // The provider's 1234 survives, and its provenance stays NULL — not 'derived'.
        expect(await read(db, 'a1')).toEqual({ duration_ms: 1234, duration_source: null });
    });

    test('leaves a session gap unmeasured rather than billing it as work', async () => {
        const db = await setup();
        await insert(db, { hash: 'u1', seq: 1, role: 'user', ts: '2026-08-28T10:00:00.000Z' });
        const overCeiling = new Date(Date.parse('2026-08-28T10:00:00.000Z') + DERIVED_DURATION_CEILING_MS + 60_000);
        await insert(db, { hash: 'a1', seq: 2, role: 'assistant', ts: overCeiling.toISOString() });

        const result = await deriveAssistantDurations(db);

        expect(result.derived).toBe(0);
        expect(result.skippedOverCeiling).toBe(1);
        expect(await read(db, 'a1')).toEqual({ duration_ms: null, duration_source: null });
    });

    test('leaves a non-positive delta unmeasured rather than rounding it to zero', async () => {
        const db = await setup();
        await insert(db, { hash: 'u1', seq: 1, role: 'user', ts: '2026-08-28T10:00:00.000Z' });
        await insert(db, { hash: 'a1', seq: 2, role: 'assistant', ts: '2026-08-28T10:00:00.000Z' });

        await deriveAssistantDurations(db);

        // Absent is not zero (0680 R6): a same-timestamp pair proves nothing about duration.
        expect(await read(db, 'a1')).toEqual({ duration_ms: null, duration_source: null });
    });

    test('does not reach across sessions for the preceding record', async () => {
        const db = await setup();
        await insert(db, { hash: 'u1', seq: 1, role: 'user', ts: '2026-08-28T10:00:00.000Z', session: 'sess-a' });
        await insert(db, { hash: 'a1', seq: 1, role: 'assistant', ts: '2026-08-28T10:00:03.000Z', session: 'sess-b' });

        const result = await deriveAssistantDurations(db);

        // `a1` is the first record of sess-b — there is no predecessor to measure against.
        expect(result.derived).toBe(0);
        expect(await read(db, 'a1')).toEqual({ duration_ms: null, duration_source: null });
    });

    test('is idempotent across repeated runs', async () => {
        const db = await setup();
        await insert(db, { hash: 'u1', seq: 1, role: 'user', ts: '2026-08-28T10:00:00.000Z' });
        await insert(db, { hash: 'a1', seq: 2, role: 'assistant', ts: '2026-08-28T10:00:04.500Z' });

        const first = await deriveAssistantDurations(db);
        const second = await deriveAssistantDurations(db);

        expect(first.derived).toBe(1);
        expect(second.derived).toBe(0);
        expect(await read(db, 'a1')).toEqual({ duration_ms: 4500, duration_source: 'derived' });
    });
});
