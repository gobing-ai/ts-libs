import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbAdapter } from './adapter';
import type {
    SelectOrderedLimitDb,
    SelectProjectionDb,
    UpdateChangesDb,
    UpdateReturningDb,
    UpdateVoidDb,
} from './drizzle-builders';
import { EntityDao } from './entity-dao';
import { queueJobs } from './schema/queue-jobs';

/**
 * Aggregate queue statistics by job status.
 */
export interface QueueStats {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
}

/** Options for enqueuing a job: retry policy, delay, TTL, and execution policy. */
export interface QueueEnqueueOptions {
    /** Total attempts allowed (default 3). */
    maxRetries?: number;
    delay?: number;
    ttlMs?: number;
    /**
     * Job execution policy persisted with the row: a positive integer ms
     * deadline, explicit `null` = unlimited (disables this job's deadline),
     * omitted = no job-level decision (consumers apply their own default).
     * Invalid explicit values are rejected before the row is created.
     */
    timeoutMs?: number | null;
}

/** Options for an atomic claim that takes lease ownership. */
export interface QueueClaimOptions {
    /** Ownership lease length in ms; omitted claims keep the legacy recovery path. */
    leaseMs?: number;
}

/**
 * Validate the persisted execution-policy leaf value. The scope-resolution
 * chain (inherit/unlimited/finite) lives in the consumer packages; the DAO
 * only stores an already-resolved job option and refuses invalid ones.
 */
function assertValidTimeoutMs(value: number | null | undefined): void {
    if (value === undefined || value === null) return;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throw new RangeError(`enqueue timeoutMs must be a positive integer or null; received ${String(value)}`);
    }
}

/** Persisted execution-policy columns derived from a validated `timeoutMs` option. */
function timeoutColumns(timeoutMs: number | null | undefined): { timeoutMs?: number; timeoutUnlimited?: number } {
    if (timeoutMs === undefined) return {};
    return timeoutMs === null ? { timeoutUnlimited: 1 } : { timeoutMs };
}

/**
 * Row type inferred from the queue_jobs Drizzle schema.
 */
export type QueueJobRecord = typeof queueJobs.$inferSelect;

/**
 * DAO for the queue_jobs table.
 *
 * Extends EntityDao for generic CRUD operations. Adds queue-specific
 * methods for job lifecycle management (enqueue, process, retry, fail).
 */
export class QueueJobDao extends EntityDao<typeof queueJobs, typeof queueJobs.id> {
    constructor(adapter: DbAdapter) {
        super(adapter, queueJobs, [queueJobs.id], 'queue_jobs');
    }

    /**
     * Enqueue a new job.
     */
    async enqueue(type: string, payload: unknown, options?: QueueEnqueueOptions): Promise<string> {
        assertValidTimeoutMs(options?.timeoutMs);
        const now = this.now();
        const id = crypto.randomUUID();

        await this.create({
            id,
            type,
            payload: JSON.stringify(payload),
            status: 'pending',
            attempts: 0,
            maxRetries: options?.maxRetries ?? 3,
            nextRetryAt: options?.delay !== undefined ? now + options.delay : now,
            ...(options?.ttlMs !== undefined ? { expiresAt: now + options.ttlMs } : {}),
            ...timeoutColumns(options?.timeoutMs),
        });

        return id;
    }

    /**
     * Enqueue multiple jobs in a single batch.
     */
    async enqueueBatch(jobs: Array<{ type: string; payload: unknown } & QueueEnqueueOptions>): Promise<string[]> {
        for (const job of jobs) {
            assertValidTimeoutMs(job.timeoutMs);
        }
        const now = this.now();
        const ids: string[] = [];

        const rows = jobs.map((job) => {
            const id = crypto.randomUUID();
            ids.push(id);

            return {
                id,
                type: job.type,
                payload: JSON.stringify(job.payload),
                status: 'pending' as const,
                attempts: 0,
                maxRetries: job.maxRetries ?? 3,
                nextRetryAt: job.delay !== undefined ? now + job.delay : now,
                ...(job.ttlMs !== undefined ? { expiresAt: now + job.ttlMs } : {}),
                ...timeoutColumns(job.timeoutMs),
            };
        });

        if (rows.length > 0) {
            await this.tx(async (tx) => {
                for (const row of rows) {
                    await tx.insert(queueJobs).values(row);
                }
            });
        }

        return ids;
    }

    /**
     * Get a job by ID.
     */
    async getById(id: string): Promise<QueueJobRecord | undefined> {
        return this.findBy(queueJobs.id, id);
    }

    /**
     * Get aggregate job counts by status.
     */
    async getStats(): Promise<QueueStats> {
        const result = await (this.db as SelectProjectionDb)
            .select({
                status: queueJobs.status,
                count: sql`count(*)`,
            })
            .from(queueJobs)
            .groupBy(queueJobs.status);

        const rows = result as { status: string; count: unknown }[];
        const map = Object.fromEntries(rows.map((r) => [r.status, Number(r.count ?? 0)]));

        return {
            pending: map.pending ?? 0,
            processing: map.processing ?? 0,
            completed: map.completed ?? 0,
            failed: map.failed ?? 0,
        };
    }

    /**
     * Count jobs by status.
     */
    async countByStatus(status: string): Promise<number> {
        const result = await (this.db as SelectProjectionDb)
            .select({ value: sql`count(*)` })
            .from(queueJobs)
            .where(sql`${queueJobs.status} = ${status}`);

        return (result as { value: number }[])[0]?.value ?? 0;
    }

    /**
     * Find pending jobs that are ready for processing (nextRetryAt <= now).
     */
    async findPending(batchSize: number): Promise<QueueJobRecord[]> {
        const now = this.now();

        const result = await (this.db as SelectOrderedLimitDb)
            .select()
            .from(queueJobs)
            .where(
                sql`${queueJobs.status} = 'pending' AND (${queueJobs.nextRetryAt} IS NULL OR ${queueJobs.nextRetryAt} <= ${now})`,
            )
            .orderBy(queueJobs.createdAt)
            .limit(batchSize);

        return result as QueueJobRecord[];
    }

    /**
     * Atomically claim ready pending jobs — and recover expired leased
     * attempts — for processing.
     *
     * The update and selection happen in one SQLite statement so competing
     * consumers only receive rows they actually transitioned to processing.
     * When `options.leaseMs` is provided the claimed row takes an ownership
     * lease and a fresh attempt token; the token fences mutations and keeps
     * rival consumers from re-claiming the live attempt until the lease
     * expires. Expired leased rows (worker loss) are recovered here with a
     * fresh token — not by the age-based `resetStuckJobs` sweep, which skips
     * token-carrying rows. Claims WITHOUT `leaseMs` mint no ownership markers
     * (and clear any stale ones on reclaim) so the row keeps the legacy
     * recovery path through the age sweep — a token without a lease would
     * make the row unrecoverable by both paths.
     */
    async claimReady(batchSize: number, options?: QueueClaimOptions): Promise<QueueJobRecord[]> {
        const limit = Math.floor(batchSize);
        if (limit <= 0) return [];

        const now = this.now();
        const leaseMs = options?.leaseMs;
        const leased = leaseMs !== undefined;
        const leaseExpiresAt = leased ? now + leaseMs : null;
        const reclaimable = sql`(
            ${queueJobs.status} = 'pending'
            AND (${queueJobs.nextRetryAt} IS NULL OR ${queueJobs.nextRetryAt} <= ${now})
        ) OR (
            ${queueJobs.status} = 'processing'
            AND ${queueJobs.attemptToken} IS NOT NULL
            AND ${queueJobs.leaseExpiresAt} IS NOT NULL
            AND ${queueJobs.leaseExpiresAt} <= ${now}
        )`;

        const result = await (this.db as UpdateReturningDb)
            .update(queueJobs)
            .set({
                status: 'processing',
                processingAt: now,
                updatedAt: now,
                attemptToken: leased ? sql`lower(hex(randomblob(16)))` : null,
                leaseExpiresAt,
            })
            .where(
                sql`${queueJobs.id} IN (
                    SELECT id
                    FROM ${queueJobs}
                    WHERE ${reclaimable}
                    ORDER BY created_at
                    LIMIT ${limit}
                )
                AND ${reclaimable}`,
            )
            .returning();

        return result as QueueJobRecord[];
    }

    /**
     * Mark jobs as processing.
     */
    async markProcessing(ids: string[]): Promise<void> {
        if (ids.length === 0) return;

        const now = this.now();

        await (this.db as UpdateVoidDb)
            .update(queueJobs)
            .set({ status: 'processing', processingAt: now, updatedAt: now })
            .where(and(inArray(queueJobs.id, ids), eq(queueJobs.status, 'pending')));
    }

    /**
     * Mark a job as completed.
     *
     * When `attemptToken` is supplied the mutation is fenced: it applies only
     * if the row is still owned by that attempt. Returns whether it applied.
     */
    async markCompleted(id: string, attemptToken?: string): Promise<boolean> {
        const where =
            attemptToken === undefined
                ? eq(queueJobs.id, id)
                : and(eq(queueJobs.id, id), eq(queueJobs.attemptToken, attemptToken));
        const result = await (this.db as UpdateChangesDb)
            .update(queueJobs)
            .set({
                status: 'completed',
                processingAt: null,
                attemptToken: null,
                leaseExpiresAt: null,
                updatedAt: this.now(),
            })
            .where(where);
        return (result as { changes: number }).changes === 1;
    }

    /**
     * Mark a job as failed, fenced by fresh attempt ownership when supplied.
     */
    async markFailed(id: string, attempts: number, error: string, attemptToken?: string): Promise<boolean> {
        const where =
            attemptToken === undefined
                ? eq(queueJobs.id, id)
                : and(eq(queueJobs.id, id), eq(queueJobs.attemptToken, attemptToken));
        const result = await (this.db as UpdateChangesDb)
            .update(queueJobs)
            .set({
                status: 'failed',
                attempts,
                lastError: error,
                processingAt: null,
                attemptToken: null,
                leaseExpiresAt: null,
                updatedAt: this.now(),
            })
            .where(where);
        return (result as { changes: number }).changes === 1;
    }

    /**
     * Reset a job to pending for retry with backoff, fenced by fresh attempt
     * ownership when supplied.
     */
    async markForRetry(
        id: string,
        attempts: number,
        errorMessage: string,
        nextRetryAt: number,
        attemptToken?: string,
    ): Promise<boolean> {
        const where =
            attemptToken === undefined
                ? eq(queueJobs.id, id)
                : and(eq(queueJobs.id, id), eq(queueJobs.attemptToken, attemptToken));
        const result = await (this.db as UpdateChangesDb)
            .update(queueJobs)
            .set({
                status: 'pending',
                attempts,
                lastError: errorMessage,
                nextRetryAt,
                processingAt: null,
                attemptToken: null,
                leaseExpiresAt: null,
                updatedAt: this.now(),
            })
            .where(where);
        return (result as { changes: number }).changes === 1;
    }

    /**
     * Extend the ownership lease of a claimed attempt.
     *
     * Applies only while the row is still owned by `attemptToken`; a `false`
     * return means ownership was lost (expired and reclaimed by another
     * consumer) and the caller must abort and fence its acknowledgements.
     */
    async renewLease(id: string, attemptToken: string, leaseMs: number): Promise<boolean> {
        const now = this.now();
        const result = await (this.db as UpdateChangesDb)
            .update(queueJobs)
            .set({ leaseExpiresAt: now + leaseMs, updatedAt: now })
            .where(
                and(eq(queueJobs.id, id), eq(queueJobs.attemptToken, attemptToken), eq(queueJobs.status, 'processing')),
            );
        return (result as { changes: number }).changes === 1;
    }

    /**
     * Reset stuck processing jobs (processing beyond visibility timeout).
     *
     * Age-based legacy recovery only: rows carrying an attempt token are
     * lease-owned and recover exclusively through their expired lease in
     * `claimReady`, never by processing age.
     */
    async resetStuckJobs(visibilityTimeout: number): Promise<number> {
        const cutoff = this.now() - visibilityTimeout;

        const result = await (this.db as UpdateChangesDb)
            .update(queueJobs)
            .set({ status: 'pending', processingAt: null, updatedAt: this.now() })
            .where(
                sql`${queueJobs.status} = 'processing' AND ${queueJobs.processingAt} IS NOT NULL AND ${queueJobs.processingAt} <= ${cutoff}
                AND ${queueJobs.attemptToken} IS NULL`,
            );

        return (result as { changes: number }).changes;
    }

    /**
     * Mark expired pending jobs as failed.
     *
     * Jobs where `expires_at IS NOT NULL AND expires_at <= now` are
     * transitioned to `failed` with an expiry error message.
     */
    async failExpiredJobs(): Promise<number> {
        const now = this.now();

        const result = await (this.db as UpdateChangesDb)
            .update(queueJobs)
            .set({
                status: 'failed',
                lastError: 'Job expired — not processed before TTL deadline',
                updatedAt: now,
                attempts: sql`${queueJobs.attempts} + 1`,
                processingAt: null,
            })
            .where(
                sql`${queueJobs.status} = 'pending' AND ${queueJobs.expiresAt} IS NOT NULL AND ${queueJobs.expiresAt} <= ${now}`,
            );

        return (result as { changes: number }).changes;
    }
}
