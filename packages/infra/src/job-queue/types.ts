/**
 * Job queue types for async work processing with retry.
 *
 * **Types only** — the DB-backed `DbQueue` and `DbConsumer` implementations
 * that drive the job-queue subsystem live in `@spur/core`. These interfaces
 * are provided here so `EventBus` and other infra components can reference
 * the queue contract without a circular dependency on the DB layer.
 */

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

export interface EnqueueOptions {
    maxRetries?: number;
    delay?: number;
    ttlMs?: number;
}

export interface JobQueue<T = unknown> {
    enqueue(type: string, payload: T, options?: EnqueueOptions): Promise<string>;
    enqueueBatch(jobs: Array<{ type: string; payload: T } & EnqueueOptions>): Promise<string[]>;
}

export type JobHandler<T = unknown> = (job: Job<T>) => Promise<void>;

export interface QueueStats {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
}

export interface QueueConsumerConfig {
    pollInterval?: number;
    batchSize?: number;
    maxConcurrency?: number;
    visibilityTimeout?: number;
    baseDelay?: number;
    maxDelay?: number;
    drainTimeoutMs?: number;
    maxPollBackoff?: number;
}

export interface QueueConsumer<T = unknown> {
    register(type: string, handler: JobHandler<T>): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    stats(): Promise<QueueStats>;
}
