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
    /** Total attempts allowed, not retries *after* the first — a job fails once `attempts >= maxRetries`. */
    maxRetries: number;
    createdAt: number;
    updatedAt: number;
    nextRetryAt: number | null;
    lastError: string | null;
    processingAt: number | null;
}

/** Options for enqueuing a job: retry policy, delay, and TTL. */
export interface EnqueueOptions {
    /** Total attempts allowed (default 3) — `maxRetries: 1` runs the job once with no retry. */
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
    /** Upper bound (ms, default 30_000) on how long `stop()` waits for in-flight work to drain. */
    drainTimeoutMs?: number;
    /**
     * Optional bus for queue lifecycle events with correlator-grade detail payloads:
     * `queue.consumer.started` / `queue.consumer.stopped` (config snapshot + drain
     * outcome), `queue.job.enqueued` / `queue.job.completed` / `queue.job.failed` /
     * `queue.job.retrying`. Details carry job identity, timing, and retry counters
     * only — never the business payload `T`. Omitting it leaves the consumer silent.
     */
    events?: EventBus<QueueEvents>;
}

/** Consumer interface for the job queue — register handlers and control the processing loop. */
export interface QueueConsumer<T = unknown> {
    register(type: string, handler: JobHandler<T>): void;
    start(): Promise<void>;
    /**
     * Stop polling and drain work already in flight, including a poll cycle that has
     * claimed nothing yet. Resolves once the drain completes or `drainTimeoutMs`
     * elapses — whichever comes first, so a hung handler cannot block shutdown.
     */
    stop(): Promise<void>;
    stats(): Promise<QueueStats>;
}
