/**
 * Job queue types for async work processing with retry.
 *
 * The concrete DB-backed implementations live beside these interfaces in
 * `DBJobQueue` and `DBQueueConsumer`.
 */

import type { EventBus } from '../event-bus/event-bus';
import type { QueueEvents } from '../events';

/** A queued job with status tracking, retry metadata, and timestamps. */
export interface Job<T = unknown> {
    id: string;
    type: string;
    payload: T;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    attempts: number;
    maxRetries: number;
    createdAt: number;
    updatedAt: number;
    nextRetryAt: number | null;
    lastError: string | null;
    processingAt: number | null;
}

/** Options for enqueuing a job: retry policy, delay, and TTL. */
export interface EnqueueOptions {
    maxRetries?: number;
    delay?: number;
    ttlMs?: number;
}

/** Producer interface for the job queue — enqueue single jobs or batches. */
export interface JobQueue<T = unknown> {
    enqueue(type: string, payload: T, options?: EnqueueOptions): Promise<string>;
    enqueueBatch(jobs: Array<{ type: string; payload: T } & EnqueueOptions>): Promise<string[]>;
    stats(): Promise<QueueStats>;
}

/** Async handler that processes a single job. */
export type JobHandler<T = unknown> = (job: Job<T>) => Promise<void>;

/** Aggregate statistics for a job queue: counts by status. */
export interface QueueStats {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
}

/** Configuration for a queue consumer: polling, concurrency, and backoff. */
export interface QueueConsumerConfig {
    pollInterval?: number;
    batchSize?: number;
    maxConcurrency?: number;
    visibilityTimeout?: number;
    baseDelay?: number;
    maxDelay?: number;
    drainTimeoutMs?: number;
    /**
     * Optional bus for queue lifecycle events: `queue.consumer.started` /
     * `queue.consumer.stopped` and `queue.job.completed` / `queue.job.failed` /
     * `queue.job.retrying`. Omitting it leaves the consumer silent (default).
     */
    events?: EventBus<QueueEvents>;
}

/** Consumer interface for the job queue — register handlers and control the processing loop. */
export interface QueueConsumer<T = unknown> {
    register(type: string, handler: JobHandler<T>): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    stats(): Promise<QueueStats>;
}
