import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbClient } from './adapter';
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
    constructor(db: DbClient) {
        super(db, queueJobs, queueJobs.id, 'queue_jobs');
    }

    /**
     * Enqueue a new job.
     */
    async enqueue(
        type: string,
        payload: unknown,
        options?: { maxRetries?: number; delay?: number; ttlMs?: number },
    ): Promise<string> {
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
        });

        return id;
    }

    /**
     * Enqueue multiple jobs in a single batch.
     */
    async enqueueBatch(
        jobs: Array<{ type: string; payload: unknown } & { maxRetries?: number; delay?: number; ttlMs?: number }>,
    ): Promise<string[]> {
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
            };
        });

        if (rows.length > 0) {
            await this.withTransaction(async (tx) => {
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
        const result = await (
            this.db as unknown as {
                select: (fn: unknown) => { from: (t: unknown) => { groupBy: (g: unknown) => Promise<unknown[]> } };
            }
        )
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
        const result = await (
            this.db as unknown as {
                select: (fn: unknown) => { from: (t: unknown) => { where: (w: unknown) => Promise<unknown[]> } };
            }
        )
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

        const result = await (
            this.db as unknown as {
                select: () => {
                    from: (t: unknown) => {
                        where: (w: unknown) => {
                            orderBy: (o: unknown) => { limit: (l: number) => Promise<unknown[]> };
                        };
                    };
                };
            }
        )
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
     * Atomically claim ready pending jobs for processing.
     *
     * The update and selection happen in one SQLite statement so competing
     * consumers only receive rows they actually transitioned to processing.
     */
    async claimReady(batchSize: number): Promise<QueueJobRecord[]> {
        const limit = Math.floor(batchSize);
        if (limit <= 0) return [];

        const now = this.now();

        const result = await (
            this.db as unknown as {
                update: (t: unknown) => {
                    set: (v: unknown) => {
                        where: (w: unknown) => {
                            returning: () => Promise<unknown[]>;
                        };
                    };
                };
            }
        )
            .update(queueJobs)
            .set({ status: 'processing', processingAt: now, updatedAt: now })
            .where(
                sql`${queueJobs.id} IN (
                    SELECT id
                    FROM ${queueJobs}
                    WHERE status = 'pending'
                      AND (next_retry_at IS NULL OR next_retry_at <= ${now})
                    ORDER BY created_at
                    LIMIT ${limit}
                )
                AND ${queueJobs.status} = 'pending'`,
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

        await (
            this.db as unknown as {
                update: (t: unknown) => { set: (v: unknown) => { where: (w: unknown) => Promise<unknown> } };
            }
        )
            .update(queueJobs)
            .set({ status: 'processing', processingAt: now, updatedAt: now })
            .where(and(inArray(queueJobs.id, ids), eq(queueJobs.status, 'pending')));
    }

    /**
     * Mark a job as completed.
     */
    async markCompleted(id: string): Promise<void> {
        await this.update(id, {
            status: 'completed',
            processingAt: null,
        });
    }

    /**
     * Mark a job as failed.
     */
    async markFailed(id: string, attempts: number, error: string): Promise<void> {
        await this.update(id, {
            status: 'failed',
            attempts,
            lastError: error,
            processingAt: null,
        });
    }

    /**
     * Reset a job to pending for retry with backoff.
     */
    async markForRetry(id: string, attempts: number, errorMessage: string, nextRetryAt: number): Promise<void> {
        await this.update(id, {
            status: 'pending',
            attempts,
            lastError: errorMessage,
            nextRetryAt,
            processingAt: null,
        });
    }

    /**
     * Reset stuck processing jobs (processing beyond visibility timeout).
     */
    async resetStuckJobs(visibilityTimeout: number): Promise<number> {
        const cutoff = this.now() - visibilityTimeout;

        const result = await (
            this.db as unknown as {
                update: (t: unknown) => {
                    set: (v: unknown) => { where: (w: unknown) => Promise<{ changes: number }> };
                };
            }
        )
            .update(queueJobs)
            .set({ status: 'pending', processingAt: null, updatedAt: this.now() })
            .where(
                sql`${queueJobs.status} = 'processing' AND ${queueJobs.processingAt} IS NOT NULL AND ${queueJobs.processingAt} <= ${cutoff}`,
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

        const result = await (
            this.db as unknown as {
                update: (t: unknown) => {
                    set: (v: unknown) => { where: (w: unknown) => Promise<{ changes: number }> };
                };
            }
        )
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
