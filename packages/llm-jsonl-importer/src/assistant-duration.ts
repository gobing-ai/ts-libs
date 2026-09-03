import type { DbAdapter } from '@gobing-ai/ts-db';

/**
 * ETL-derived assistant-step duration (repatriated upstream from Spur task 0747 / ADR-105).
 *
 * Four of six sources — `claude`, `pi`, `codex`, `agy` — write no per-step
 * `duration_ms` at all, so bottleneck ranking and per-model latency were unusable for
 * the two busiest of them and ~73% of the measured span could not be attributed to
 * llm/tool/idle. The transcripts carry a per-record `ts`, so the delta from the
 * preceding record in the same session is derivable here.
 *
 * **It is an approximation and is labelled as one.** The delta includes queue and
 * network time, which is arguably what "assistant step duration" should mean for
 * bottleneck ranking, but it is not the provider's own number. `duration_source` carries
 * that distinction to every consumer: `NULL` is provider-reported, `'derived'` is this
 * function's work. Nothing may present the two as the same measurement.
 */

/** `history_message.duration_source` values. `NULL` means provider-reported. */
export const DURATION_SOURCE_DERIVED = 'derived';

/**
 * Deltas above this are session gaps, not work: the operator walked away and came back.
 * Attributing an overnight gap to an assistant step would corrupt the very ranking this
 * derivation exists to make usable, so those rows stay unmeasured.
 */
export const DERIVED_DURATION_CEILING_MS = 30 * 60 * 1000;

/** What one derivation pass changed, and what it deliberately left alone. */
export interface DeriveAssistantDurationsResult {
    /** Rows that gained a derived `duration_ms` on this pass. */
    derived: number;
    /** Candidate rows left unmeasured because the delta exceeded the ceiling. */
    skippedOverCeiling: number;
}

/**
 * Fill `duration_ms` for assistant rows that have none, from the timestamp delta to the
 * preceding record in the same session.
 *
 * Idempotent and additive: a row whose `duration_ms` is already set is never touched, so
 * a provider measurement always wins over a derived one, and re-running after a later
 * import only fills rows the earlier pass could not reach.
 */
export async function deriveAssistantDurations(db: DbAdapter): Promise<DeriveAssistantDurationsResult> {
    const candidateSql = `
        WITH ordered AS (
            SELECT record_hash,
                   role,
                   duration_ms,
                   ts,
                   LAG(ts) OVER (PARTITION BY source, session_id ORDER BY seq) AS prev_ts
            FROM history_message
            WHERE ts IS NOT NULL AND ts LIKE '____-__-__T%'
        )
        SELECT record_hash AS recordHash,
               CAST(ROUND((unixepoch(ts, 'subsec') - unixepoch(prev_ts, 'subsec')) * 1000) AS INTEGER) AS deltaMs
        FROM ordered
        WHERE role = 'assistant' AND duration_ms IS NULL AND prev_ts IS NOT NULL`;

    const rows = await db.queryAll<{ recordHash: string; deltaMs: number | null }>(candidateSql);

    let derived = 0;
    let skippedOverCeiling = 0;
    for (const row of rows) {
        // A non-positive delta means the records share a timestamp or arrived out of
        // order; there is no duration to claim, so leave the row unmeasured rather than
        // invent a zero (0680 R6: absent is not zero).
        if (row.deltaMs === null || row.deltaMs <= 0) continue;
        if (row.deltaMs > DERIVED_DURATION_CEILING_MS) {
            skippedOverCeiling += 1;
            continue;
        }
        await db.run(
            'UPDATE history_message SET duration_ms = ?, duration_source = ? WHERE record_hash = ? AND duration_ms IS NULL',
            row.deltaMs,
            DURATION_SOURCE_DERIVED,
            row.recordHash,
        );
        derived += 1;
    }
    return { derived, skippedOverCeiling };
}
