/**
 * Job queue types for async work processing with retry.
 *
 * The concrete DB-backed implementations live beside these interfaces in
 * `DBJobQueue` and `DBQueueConsumer`.
 */

import type { EventBus } from '../event-bus/event-bus';
import type { QueueEvents } from '../events';
import type { ExecutionContext } from '../execution-policy';

/** A queued job with status tracking, retry metadata, timestamps, and its persisted execution policy. */
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
    /**
     * Job-level execution policy as persisted: a positive integer ms deadline,
     * explicit `null` = unlimited, or `undefined` = no job-level decision (the
     * consumer default applies). Never the resolved per-attempt value.
     */
    timeoutMs?: number | null;
}

/** Options for enqueuing a job: retry policy, delay, TTL, and execution policy. */
export interface EnqueueOptions {
    /** Total attempts allowed (default 3) — `maxRetries: 1` runs the job once with no retry. */
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

/** Producer interface for the job queue — enqueue single jobs or batches. */
export interface JobQueue<T = unknown> {
    enqueue(type: string, payload: T, options?: EnqueueOptions): Promise<string>;
    enqueueBatch(jobs: Array<{ type: string; payload: T } & EnqueueOptions>): Promise<string[]>;
    stats(): Promise<QueueStats>;
}

/**
 * Async handler that processes a single job. The context carries the shared
 * execution deadline clock for this attempt; single-argument handlers stay
 * assignable.
 */
export type JobHandler<T = unknown> = (job: Job<T>, context: ExecutionContext) => Promise<void>;

/** Aggregate statistics for a job queue: counts by status. */
export interface QueueStats {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
}

/** Configuration for a queue consumer: polling, concurrency, backoff, and the default execution policy. */
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
     * Shutdown drain policy (A21). `'bounded'` (default): `stop()` gives up after
     * `drainTimeoutMs`; attempts still running keep their leases, keep renewing, and
     * are acknowledged when they settle. `'drain-to-completion'`: `stop()` waits for
     * all in-flight attempts to settle, however long that takes.
     */
    drainPolicy?: 'bounded' | 'drain-to-completion';
    /**
     * Default execution policy for jobs without their own persisted decision
     * (A21): a positive integer ms deadline or explicit `null` = unlimited.
     * First-match-wins: an explicit job option — including job `null` — beats
     * this default; absence inherits it.
     */
    defaultTimeoutMs?: number | null;
    /**
     * Identity of the queue this consumer polls. Runtime-required whenever `events` is
     * configured (ADR-068): an observable consumer must never emit an anonymous lifecycle
     * row. Silent consumers (no `events`) may omit it. A supplied value must be non-empty
     * and already trimmed; it is validated but never normalized.
     */
    queueName?: string;
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
     * Request cooperative cancellation of a claimed attempt (A21). The context
     * signal aborts with reason `'cancelled'`; the attempt is allowed to settle
     * and is then failed without retry. Resolves `false` when the job is not
     * currently owned by this consumer.
     */
    cancel(jobId: string): Promise<boolean>;
    /**
     * Stop polling and drain work already in flight, including a poll cycle that has
     * claimed nothing yet. Under the default `'bounded'` policy this resolves once the
     * drain completes or `drainTimeoutMs` elapses; `'drain-to-completion'` ignores the
     * bound and waits for every in-flight attempt.
     */
    stop(): Promise<void>;
    stats(): Promise<QueueStats>;
}
