import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { standardColumns } from './common';

/**
 * Drizzle schema definition for the queue_jobs table.
 */
export const queueJobs = sqliteTable(
    'queue_jobs',
    {
        id: text('id').primaryKey(),
        type: text('type').notNull(),
        payload: text('payload').notNull(),
        status: text('status').notNull().default('pending'),
        attempts: integer('attempts').notNull().default(0),
        maxRetries: integer('max_retries').notNull().default(3),
        ...standardColumns,
        nextRetryAt: integer('next_retry_at'),
        lastError: text('last_error'),
        processingAt: integer('processing_at'),
        expiresAt: integer('expires_at'),
    },
    (table) => [index('queue_jobs_ready_idx').on(table.status, table.nextRetryAt, table.createdAt)],
);
