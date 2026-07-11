import type { QueueJobDao, QueueJobRecord, QueueStats } from '@gobing-ai/ts-db';
import type { EventBus } from '../event-bus/event-bus';
import type { QueueEvents } from '../events';
import { getLogger, type Logger } from '../logger';
import {
    getQueueJobCompletedTotal,
    getQueueJobEnqueuedTotal,
    getQueueJobFailedTotal,
    getQueueJobProcessingDuration,
} from '../telemetry/metrics';
import { addSpanAttributes, traceAsync } from '../telemetry/tracing';
import type { EnqueueOptions, Job, JobHandler, JobQueue, QueueConsumer, QueueConsumerConfig } from './types';

let _queueLogger: Logger | undefined;
function queueLogger(): Logger {
    if (!_queueLogger) _queueLogger = getLogger('job-queue');
    return _queueLogger;
}

/** DB-backed job queue implementation over `@gobing-ai/ts-db`'s `QueueJobDao`. */
export class DBJobQueue<T = unknown> implements JobQueue<T> {
    constructor(
        readonly dao: QueueJobDao,
        private readonly events?: EventBus<QueueEvents>,
    ) {}

    async enqueue(type: string, payload: T, options?: EnqueueOptions): Promise<string> {
        const id = await this.dao.enqueue(type, payload, options);
        getQueueJobEnqueuedTotal().add(1, { type });
        await this.events?.emit('queue.job.enqueued', { jobId: id, type });
        return id;
    }

    async enqueueBatch(jobs: Array<{ type: string; payload: T } & EnqueueOptions>): Promise<string[]> {
        const ids = await this.dao.enqueueBatch(jobs);
        getQueueJobEnqueuedTotal().add(jobs.length);
        if (this.events) {
            for (const [index, jobId] of ids.entries()) {
                await this.events.emit('queue.job.enqueued', { jobId, type: jobs[index]?.type ?? 'unknown' });
            }
        }
        return ids;
    }

    async stats(): Promise<QueueStats> {
        return this.dao.getStats();
    }
}

/** DB-backed queue consumer with polling, retry, and visibility-timeout handling. */
export class DBQueueConsumer<T = unknown> implements QueueConsumer<T> {
    private readonly handlers = new Map<string, JobHandler<T>>();
    private readonly pollInterval: number;
    private readonly batchSize: number;
    private readonly maxConcurrency: number;
    private readonly visibilityTimeout: number;
    private readonly baseDelay: number;
    private readonly maxDelay: number;
    private readonly drainTimeoutMs: number;
    private readonly events: EventBus<QueueEvents> | undefined;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private inFlight = 0;

    constructor(
        private readonly dao: QueueJobDao,
        config: QueueConsumerConfig = {},
    ) {
        this.pollInterval = nonNegativeFiniteConfig('pollInterval', config.pollInterval ?? 1_000);
        this.batchSize = positiveIntegerConfig('batchSize', config.batchSize ?? 10);
        this.maxConcurrency = positiveIntegerConfig('maxConcurrency', config.maxConcurrency ?? this.batchSize);
        this.visibilityTimeout = positiveFiniteConfig('visibilityTimeout', config.visibilityTimeout ?? 30_000);
        this.baseDelay = nonNegativeFiniteConfig('baseDelay', config.baseDelay ?? 1_000);
        this.maxDelay = nonNegativeFiniteConfig('maxDelay', config.maxDelay ?? 60_000);
        this.drainTimeoutMs = nonNegativeFiniteConfig('drainTimeoutMs', config.drainTimeoutMs ?? 30_000);
        this.events = config.events;
    }

    register(type: string, handler: JobHandler<T>): void {
        this.handlers.set(type, handler);
    }

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.schedule(0);
        await this.events?.emit('queue.consumer.started');
    }

    async stop(): Promise<void> {
        const wasRunning = this.running;
        this.running = false;
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        const deadline = Date.now() + this.drainTimeoutMs;
        while (this.inFlight > 0 && Date.now() < deadline) {
            await sleep(10);
        }
        if (wasRunning) await this.events?.emit('queue.consumer.stopped');
    }

    async stats(): Promise<QueueStats> {
        return this.dao.getStats();
    }

    /** Process one batch immediately. Useful for tests, schedulers, and manual drains. */
    async processOnce(): Promise<number> {
        return traceAsync('queue.poll', async () => {
            await this.dao.resetStuckJobs(this.visibilityTimeout);
            await this.dao.failExpiredJobs();

            const jobs = await this.dao.claimReady(this.batchSize);
            let processed = 0;

            for (let index = 0; index < jobs.length; index += this.maxConcurrency) {
                const batch = jobs.slice(index, index + this.maxConcurrency);
                await Promise.all(
                    batch.map(async (job) => {
                        this.inFlight += 1;
                        try {
                            await this.processJob(job);
                            processed += 1;
                        } finally {
                            this.inFlight -= 1;
                        }
                    }),
                );
            }

            addSpanAttributes({ 'queue.claimed': jobs.length, 'queue.processed': processed });
            return processed;
        });
    }

    private schedule(delay: number): void {
        this.timer = setTimeout(() => {
            void this.poll();
        }, delay);
    }

    private async poll(): Promise<void> {
        if (!this.running) return;
        try {
            await this.processOnce();
        } catch (error) {
            // The timer fires poll() as a floating promise — a DAO/processing error
            // must be contained here or it becomes an unhandled rejection that can
            // kill the process. Log and let the next cycle retry.
            queueLogger().error('queue poll cycle failed', {
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            if (this.running) this.schedule(this.pollInterval);
        }
    }

    private async processJob(record: QueueJobRecord): Promise<void> {
        let job: Job<T>;
        try {
            job = toJob<T>(record);
        } catch (error) {
            // Corrupt payload — the job can never parse; route it through the
            // retry/fail path instead of rejecting the whole batch.
            await this.failOrRetry(record, error);
            return;
        }
        return traceAsync('queue.job.process', async () => {
            addSpanAttributes({
                'queue.job_id': job.id,
                'queue.job_type': job.type,
                'queue.job_attempt': job.attempts,
            });

            const handler = this.handlers.get(job.type);
            if (handler === undefined) {
                await this.failOrRetry(job, new Error(`No handler registered for job type "${job.type}"`));
                return;
            }

            const startMs = performance.now();
            try {
                await handler(job);
                await this.dao.markCompleted(job.id);
                getQueueJobCompletedTotal().add(1, { type: job.type });
                getQueueJobProcessingDuration().record(performance.now() - startMs, { type: job.type });
                await this.events?.emit('queue.job.completed', { jobId: job.id, type: job.type });
            } catch (error) {
                getQueueJobProcessingDuration().record(performance.now() - startMs, { type: job.type });
                await this.failOrRetry(job, error);
            }
        });
    }

    private async failOrRetry(
        job: Pick<Job<T>, 'id' | 'type' | 'attempts' | 'maxRetries'>,
        error: unknown,
    ): Promise<void> {
        const attempts = job.attempts + 1;
        const message = error instanceof Error ? error.message : String(error);
        if (attempts >= job.maxRetries) {
            await this.dao.markFailed(job.id, attempts, message);
            getQueueJobFailedTotal().add(1, { type: job.type });
            await this.events?.emit('queue.job.failed', {
                jobId: job.id,
                type: job.type,
                error: message,
                attempt: attempts,
            });
            return;
        }

        const delay = Math.min(this.maxDelay, this.baseDelay * 2 ** Math.max(0, attempts - 1));
        const nextRetryAt = Date.now() + delay;
        await this.dao.markForRetry(job.id, attempts, message, nextRetryAt);
        await this.events?.emit('queue.job.retrying', {
            jobId: job.id,
            type: job.type,
            attempt: attempts,
            nextRetryAt,
        });
    }
}

function toJob<T>(record: QueueJobRecord): Job<T> {
    return {
        id: record.id,
        type: record.type,
        payload: JSON.parse(record.payload) as T,
        status: record.status as Job<T>['status'],
        attempts: record.attempts,
        maxRetries: record.maxRetries,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        nextRetryAt: record.nextRetryAt,
        lastError: record.lastError,
        processingAt: record.processingAt,
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveIntegerConfig(name: string, value: number): number {
    if (!Number.isInteger(value) || value <= 0) {
        throw new RangeError(`Queue consumer ${name} must be a positive integer; received ${value}`);
    }
    return value;
}

function positiveFiniteConfig(name: string, value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError(`Queue consumer ${name} must be a positive finite number; received ${value}`);
    }
    return value;
}

function nonNegativeFiniteConfig(name: string, value: number): number {
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`Queue consumer ${name} must be a non-negative finite number; received ${value}`);
    }
    return value;
}
