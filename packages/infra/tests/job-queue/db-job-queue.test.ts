import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDbAdapter, type DbAdapter, QueueJobDao } from '@gobing-ai/ts-db';
import { EventBus } from '../../src/event-bus/event-bus';
import type { QueueEvents } from '../../src/events';
import { DBJobQueue, DBQueueConsumer } from '../../src/job-queue-db';
import { setLoggerMuted } from '../../src/logger';
import { _resetMetrics } from '../../src/telemetry/metrics';
import { _resetTelemetry, initTelemetry, shutdownTelemetry } from '../../src/telemetry/sdk';

let adapter: DbAdapter;
let dao: QueueJobDao;

beforeEach(async () => {
    adapter = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
    await adapter.exec(`CREATE TABLE queue_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        next_retry_at INTEGER,
        last_error TEXT,
        processing_at INTEGER,
        expires_at INTEGER
    )`);
    await adapter.exec('CREATE INDEX queue_jobs_ready_idx ON queue_jobs (status, next_retry_at, created_at)');
    dao = new QueueJobDao(adapter);
});

afterEach(() => {
    adapter.close();
});

describe('DBJobQueue', () => {
    test('enqueues single and batched jobs through QueueJobDao', async () => {
        const queue = new DBJobQueue<{ value: number }>(dao);

        const id = await queue.enqueue('single', { value: 1 });
        const ids = await queue.enqueueBatch([
            { type: 'batch', payload: { value: 2 } },
            { type: 'batch', payload: { value: 3 } },
        ]);

        expect(id).toBeTruthy();
        expect(ids).toHaveLength(2);
        expect((await queue.stats()).pending).toBe(3);
    });
});

describe('DBQueueConsumer', () => {
    test('rejects invalid numeric configuration before polling', () => {
        const invalidConfigs = [
            { name: 'batchSize', config: { batchSize: 0 } },
            { name: 'batchSize', config: { batchSize: 1.5 } },
            { name: 'maxConcurrency', config: { maxConcurrency: Number.NaN } },
            { name: 'maxConcurrency', config: { maxConcurrency: Number.POSITIVE_INFINITY } },
            { name: 'visibilityTimeout', config: { visibilityTimeout: 0 } },
            { name: 'pollInterval', config: { pollInterval: -1 } },
            { name: 'baseDelay', config: { baseDelay: Number.NaN } },
            { name: 'maxDelay', config: { maxDelay: Number.POSITIVE_INFINITY } },
            { name: 'drainTimeoutMs', config: { drainTimeoutMs: -1 } },
        ] as const;

        for (const { name, config } of invalidConfigs) {
            expect(() => new DBQueueConsumer(dao, config)).toThrow(`Queue consumer ${name}`);
        }
    });

    test('accepts zero-valued delay configuration', () => {
        expect(
            () =>
                new DBQueueConsumer(dao, {
                    pollInterval: 0,
                    baseDelay: 0,
                    maxDelay: 0,
                    drainTimeoutMs: 0,
                }),
        ).not.toThrow();
    });

    test('processOnce dispatches a ready job and marks it completed', async () => {
        const queue = new DBJobQueue<{ value: number }>(dao);
        const id = await queue.enqueue('work', { value: 7 });
        const seen: number[] = [];
        const consumer = new DBQueueConsumer<{ value: number }>(dao, { batchSize: 5 });
        consumer.register('work', async (job) => {
            seen.push(job.payload.value);
        });

        const processed = await consumer.processOnce();

        expect(processed).toBe(1);
        expect(seen).toEqual([7]);
        expect((await dao.getById(id))?.status).toBe('completed');
    });

    test('retries failed jobs until maxRetries is reached', async () => {
        const queue = new DBJobQueue<{ value: number }>(dao);
        const id = await queue.enqueue('fail-once', { value: 1 }, { maxRetries: 2 });
        const consumer = new DBQueueConsumer<{ value: number }>(dao, { baseDelay: 1, maxDelay: 1 });
        consumer.register('fail-once', async () => {
            throw new Error('handler failed');
        });

        await consumer.processOnce();
        let job = await dao.getById(id);
        expect(job?.status).toBe('pending');
        expect(job?.attempts).toBe(1);
        expect(job?.lastError).toBe('handler failed');

        await adapter.run('UPDATE queue_jobs SET next_retry_at = ? WHERE id = ?', Date.now() - 1, id);
        await consumer.processOnce();
        job = await dao.getById(id);
        expect(job?.status).toBe('failed');
        expect(job?.attempts).toBe(2);
    });

    test('queue.poll/queue.job.process tracing is transparent to processing', async () => {
        // Regression for F2: queue tracing was dropped in the migration. The
        // restored `traceAsync` wrappers must not alter behavior — with telemetry
        // enabled, processing, completion, and error propagation are unchanged.
        // (Span export itself is covered by the telemetry module's own tests; the
        // infra SDK registers no provider, so there is no active span to observe
        // here without a host-registered context manager.)
        _resetMetrics();
        initTelemetry({ enabled: true, serviceName: 'test-queue-tracing' });
        try {
            const queue = new DBJobQueue<{ value: number }>(dao);
            const okId = await queue.enqueue('ok', { value: 1 });
            const failId = await queue.enqueue('boom', { value: 2 }, { maxRetries: 1 });

            const consumer = new DBQueueConsumer<{ value: number }>(dao);
            consumer.register('ok', async () => {});
            consumer.register('boom', async () => {
                throw new Error('handler failed');
            });

            const processed = await consumer.processOnce();

            expect(processed).toBe(2);
            expect((await dao.getById(okId))?.status).toBe('completed');
            expect((await dao.getById(failId))?.status).toBe('failed');
        } finally {
            await shutdownTelemetry();
            _resetTelemetry();
            _resetMetrics();
        }
    });

    test('fails jobs with no registered handler', async () => {
        const queue = new DBJobQueue(dao);
        const id = await queue.enqueue('missing-handler', {}, { maxRetries: 1 });
        const consumer = new DBQueueConsumer(dao);

        await consumer.processOnce();

        const job = await dao.getById(id);
        expect(job?.status).toBe('failed');
        expect(job?.lastError).toContain('No handler registered');
    });

    test('stats delegates to the queue dao', async () => {
        const queue = new DBJobQueue(dao);
        await queue.enqueue('stats', {});
        const consumer = new DBQueueConsumer(dao);

        expect((await consumer.stats()).pending).toBe(1);
    });

    test('start is idempotent and stop clears polling without work', async () => {
        const consumer = new DBQueueConsumer(dao, { pollInterval: 5, drainTimeoutMs: 5 });

        await consumer.start();
        await consumer.start();
        await consumer.stop();
        await consumer.stop();

        expect((await consumer.stats()).pending).toBe(0);
    });

    test('start polls and stop waits for in-flight handlers', async () => {
        const queue = new DBJobQueue<{ value: number }>(dao);
        const id = await queue.enqueue('scheduled', { value: 9 });
        let release: () => void = () => {};
        const handlerDone = new Promise<void>((resolve) => {
            release = resolve;
        });
        const consumer = new DBQueueConsumer<{ value: number }>(dao, { pollInterval: 5, drainTimeoutMs: 100 });
        consumer.register('scheduled', async () => {
            await handlerDone;
        });

        await consumer.start();
        await waitFor(async () => (await dao.getById(id))?.status === 'processing');
        const stopping = consumer.stop();
        release();
        await stopping;

        expect((await dao.getById(id))?.status).toBe('completed');
    });

    test('stop() waits for a poll cycle that has not claimed yet (drain race regression)', async () => {
        // Regression: `inFlight` is incremented only after claimReady() resolves, so a
        // stop() landing inside that window observed 0, exited the drain loop at once,
        // and emitted `drained: true` while the cycle went on to claim and run handlers
        // after stop() had resolved. The existing drain test waits for status
        // 'processing' first, which synchronizes past this window.
        const queue = new DBJobQueue<{ value: number }>(dao);
        const id = await queue.enqueue('slow-claim', { value: 1 });

        // Delay only the claim, so stop() is guaranteed to land before any increment.
        const slowDao = new Proxy(dao, {
            get(target, prop, receiver) {
                if (prop === 'claimReady') {
                    return async (batchSize: number) => {
                        await Bun.sleep(60);
                        return target.claimReady(batchSize);
                    };
                }
                const value = Reflect.get(target, prop, receiver);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });

        const bus = new EventBus<QueueEvents>();
        let drained: boolean | undefined;
        bus.on('queue.consumer.stopped', (d) => {
            drained = d.drained;
        });

        let stopReturned = false;
        let ranAfterStop = false;
        const consumer = new DBQueueConsumer<{ value: number }>(slowDao, {
            pollInterval: 5,
            drainTimeoutMs: 1_000,
            events: bus,
        });
        consumer.register('slow-claim', async () => {
            if (stopReturned) ranAfterStop = true;
        });

        await consumer.start();
        await Bun.sleep(10); // timer fired; claimReady is mid-flight and inFlight is still 0
        await consumer.stop();
        stopReturned = true;

        await Bun.sleep(120); // an escaped cycle would run its handler inside this window
        expect(ranAfterStop).toBe(false);
        expect(drained).toBe(true);
        // The job was drained, not abandoned mid-claim.
        expect((await dao.getById(id))?.status).toBe('completed');
    });

    test('stop() gives up after drainTimeoutMs when a handler hangs', async () => {
        // The drain wait is bounded: awaiting the in-flight cycle must not let one stuck
        // handler block shutdown forever. Pairs with the race regression above — that one
        // proves stop() waits, this one proves it does not wait indefinitely.
        const queue = new DBJobQueue<{ value: number }>(dao);
        const id = await queue.enqueue('hang', { value: 1 });

        const bus = new EventBus<QueueEvents>();
        let drained: boolean | undefined;
        bus.on('queue.consumer.stopped', (d) => {
            drained = d.drained;
        });

        let release: () => void = () => {};
        const consumer = new DBQueueConsumer<{ value: number }>(dao, {
            pollInterval: 5,
            drainTimeoutMs: 50,
            events: bus,
        });
        consumer.register(
            'hang',
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );

        await consumer.start();
        await waitFor(async () => (await dao.getById(id))?.status === 'processing');

        const startedAt = Date.now();
        await consumer.stop();
        const elapsed = Date.now() - startedAt;

        expect(elapsed).toBeLessThan(2_000); // bounded by drainTimeoutMs, not by the handler
        expect(drained).toBe(false); // and honestly reported as an incomplete drain

        release(); // let the stuck cycle finish so it does not outlive the test
        await Bun.sleep(10);
    });

    test('a corrupt payload fails the job instead of rejecting the batch', async () => {
        const queue = new DBJobQueue<{ value: number }>(dao);
        const corruptId = await queue.enqueue('work', { value: 1 }, { maxRetries: 1 });
        const okId = await queue.enqueue('work', { value: 2 });
        await adapter.run('UPDATE queue_jobs SET payload = ? WHERE id = ?', '{not-json', corruptId);

        const consumer = new DBQueueConsumer<{ value: number }>(dao, { batchSize: 5 });
        consumer.register('work', async () => {});

        await consumer.processOnce();

        const corrupt = await dao.getById(corruptId);
        expect(corrupt?.status).toBe('failed');
        expect(corrupt?.lastError).toBeTruthy();
        expect((await dao.getById(okId))?.status).toBe('completed');
    });

    test('a throwing DAO during polling is contained (no unhandled rejection)', async () => {
        // Regression: poll() had no catch, so a single DAO error on the floating
        // timer promise became an unhandled rejection.
        const failingDao = {
            resetStuckJobs: async () => {
                throw new Error('db unavailable');
            },
        } as unknown as QueueJobDao;
        const consumer = new DBQueueConsumer(failingDao, { pollInterval: 5, drainTimeoutMs: 5 });

        setLoggerMuted(true);
        try {
            await consumer.start();
            await Bun.sleep(25); // several failing poll cycles
            await consumer.stop();
        } finally {
            setLoggerMuted(false);
        }
        // Reaching here without Bun reporting an unhandled rejection is the assertion.
        expect(true).toBe(true);
    });

    test('emits enriched queue lifecycle events through the injected bus', async () => {
        const captured: Array<{ event: string; detail: unknown }> = [];
        const bus = new EventBus<QueueEvents>();
        bus.on('queue.job.enqueued', (d) => captured.push({ event: 'queue.job.enqueued', detail: d }));
        bus.on('queue.job.completed', (d) => captured.push({ event: 'queue.job.completed', detail: d }));
        bus.on('queue.job.failed', (d) => captured.push({ event: 'queue.job.failed', detail: d }));
        bus.on('queue.job.retrying', (d) => captured.push({ event: 'queue.job.retrying', detail: d }));

        const queue = new DBJobQueue<{ v: number }>(dao, bus);
        await queue.enqueue('work', { v: 1 });

        const consumer = new DBQueueConsumer<{ v: number }>(dao, { events: bus });
        consumer.register('work', async () => {});
        await consumer.processOnce();

        const events = captured.map((c) => c.event);
        expect(events).toContain('queue.job.enqueued');
        expect(events).toContain('queue.job.completed');
    });

    test('emits retry and failure events through the injected bus', async () => {
        const captured: string[] = [];
        const bus = new EventBus<QueueEvents>();
        bus.on('queue.job.failed', (d) => captured.push(`failed:${d.jobId}:${d.type}`));
        bus.on('queue.job.retrying', (d) => captured.push(`retrying:${d.jobId}:${d.type}`));

        const queue = new DBJobQueue<{ v: number }>(dao);
        const id = await queue.enqueue('unstable', { v: 1 }, { maxRetries: 2 });
        const consumer = new DBQueueConsumer<{ v: number }>(dao, { events: bus, baseDelay: 1, maxDelay: 1 });
        consumer.register('unstable', async () => {
            throw new Error('oops');
        });

        await consumer.processOnce();
        expect(captured).toEqual([`retrying:${id}:unstable`]);

        await adapter.run('UPDATE queue_jobs SET next_retry_at = ? WHERE id = ?', Date.now() - 1, id);
        await consumer.processOnce();
        expect(captured).toEqual([`retrying:${id}:unstable`, `failed:${id}:unstable`]);
    });

    test('R1 — queue.consumer.started carries config snapshot', async () => {
        const bus = new EventBus<QueueEvents>();
        let started:
            | {
                  startedAt: number;
                  pollInterval: number;
                  batchSize: number;
                  maxConcurrency: number;
                  visibilityTimeout: number;
              }
            | undefined;
        bus.on('queue.consumer.started', (d) => {
            started = d;
        });

        const consumer = new DBQueueConsumer<{ v: number }>(dao, {
            events: bus,
            pollInterval: 1000,
            batchSize: 10,
            maxConcurrency: 5,
            visibilityTimeout: 30_000,
        });
        await consumer.start();
        await consumer.stop();

        expect(started).toBeDefined();
        expect(Number.isFinite(started?.startedAt)).toBe(true);
        expect(started?.pollInterval).toBe(1000);
        expect(started?.batchSize).toBe(10);
        expect(started?.maxConcurrency).toBe(5);
        expect(started?.visibilityTimeout).toBe(30_000);
    });

    test('R1b — queue.consumer.stopped carries drain outcome', async () => {
        const bus = new EventBus<QueueEvents>();
        let stopped:
            | { stoppedAt: number; drainTimeoutMs: number; inFlightAtStop: number; drained: boolean }
            | undefined;
        bus.on('queue.consumer.stopped', (d) => {
            stopped = d;
        });

        const consumer = new DBQueueConsumer<{ v: number }>(dao, {
            events: bus,
            drainTimeoutMs: 5_000,
        });
        await consumer.start();
        await consumer.stop();

        expect(stopped).toBeDefined();
        expect(Number.isFinite(stopped?.stoppedAt)).toBe(true);
        expect(stopped?.drainTimeoutMs).toBe(5_000);
        expect(stopped?.inFlightAtStop).toBe(0);
        expect(stopped?.drained).toBe(true);
    });

    test('R2 — enqueue enriches detail with correlators and omits payload', async () => {
        const bus = new EventBus<QueueEvents>();
        let enqueued:
            | {
                  jobId: string;
                  type: string;
                  enqueuedAt: number;
                  maxRetries?: number;
                  delayMs?: number;
                  ttlMs?: number;
              }
            | undefined;
        bus.on('queue.job.enqueued', (d) => {
            enqueued = d;
        });

        const queue = new DBJobQueue<{ v: number }>(dao, bus);
        const id = await queue.enqueue('FEATURE_ACTION', { v: 1 }, { maxRetries: 3, delay: 500 });

        expect(enqueued).toBeDefined();
        expect(enqueued?.jobId).toBe(id);
        expect(enqueued?.type).toBe('FEATURE_ACTION');
        expect(Number.isFinite(enqueued?.enqueuedAt)).toBe(true);
        expect(enqueued?.maxRetries).toBe(3);
        expect(enqueued?.delayMs).toBe(500);
        expect(enqueued).not.toHaveProperty('payload');
        expect(JSON.stringify(enqueued)).not.toContain('"v"');
    });

    test('R2b — batch enqueue emits one enriched event per job with matching shape', async () => {
        const bus = new EventBus<QueueEvents>();
        const enqueued: Array<{ jobId: string; type: string; enqueuedAt: number }> = [];
        bus.on('queue.job.enqueued', (d) => {
            enqueued.push(d);
        });

        const queue = new DBJobQueue<{ v: number }>(dao, bus);
        await queue.enqueueBatch([
            { type: 'a', payload: { v: 1 } },
            { type: 'b', payload: { v: 2 } },
        ]);

        expect(enqueued).toHaveLength(2);
        expect(enqueued.map((e) => e.type).sort()).toEqual(['a', 'b']);
        for (const e of enqueued) {
            expect(Number.isFinite(e.enqueuedAt)).toBe(true);
            expect(typeof e.jobId).toBe('string');
        }
    });

    test('R3 — completed job detail includes durationMs and attempt', async () => {
        const bus = new EventBus<QueueEvents>();
        let completed: { durationMs: number; attempt: number } | undefined;
        bus.on('queue.job.completed', (d) => {
            completed = d;
        });

        const queue = new DBJobQueue<{ v: number }>(dao, bus);
        const id = await queue.enqueue('work', { v: 1 });
        const consumer = new DBQueueConsumer<{ v: number }>(dao, { events: bus });
        consumer.register('work', async () => {});
        await consumer.processOnce();

        expect(completed).toBeDefined();
        expect(completed?.durationMs).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(completed?.durationMs)).toBe(true);
        expect(completed?.attempt).toBe(0);
        expect(id).toBeTruthy();
    });

    test('R4 — failed job detail includes maxRetries, attempt, and error', async () => {
        const bus = new EventBus<QueueEvents>();
        let failed:
            | { jobId: string; type: string; error: string; attempt: number; maxRetries: number; durationMs?: number }
            | undefined;
        bus.on('queue.job.failed', (d) => {
            failed = d;
        });

        const queue = new DBJobQueue<{ v: number }>(dao);
        const id = await queue.enqueue('unstable', { v: 1 }, { maxRetries: 1 });
        const consumer = new DBQueueConsumer<{ v: number }>(dao, { events: bus, baseDelay: 1, maxDelay: 1 });
        consumer.register('unstable', async () => {
            throw new Error('boom');
        });
        await consumer.processOnce();

        expect(failed).toBeDefined();
        expect(failed?.jobId).toBe(id);
        expect(failed?.type).toBe('unstable');
        expect(failed?.error).toBe('boom');
        expect(failed?.attempt).toBe(1);
        expect(failed?.maxRetries).toBe(1);
        expect(typeof failed?.durationMs).toBe('number');
    });

    test('R4b — retrying job detail includes error, nextRetryAt, and maxRetries', async () => {
        const bus = new EventBus<QueueEvents>();
        let retrying:
            | {
                  jobId: string;
                  type: string;
                  attempt: number;
                  nextRetryAt: number;
                  maxRetries: number;
                  error: string;
              }
            | undefined;
        bus.on('queue.job.retrying', (d) => {
            retrying = d;
        });

        const queue = new DBJobQueue<{ v: number }>(dao);
        const id = await queue.enqueue('unstable', { v: 1 }, { maxRetries: 3 });
        const consumer = new DBQueueConsumer<{ v: number }>(dao, { events: bus, baseDelay: 1, maxDelay: 1 });
        consumer.register('unstable', async () => {
            throw new Error('transient');
        });
        await consumer.processOnce();

        expect(retrying).toBeDefined();
        expect(retrying?.jobId).toBe(id);
        expect(retrying?.type).toBe('unstable');
        expect(retrying?.attempt).toBe(1);
        expect(retrying?.maxRetries).toBe(3);
        expect(retrying?.nextRetryAt).toBeGreaterThan(Date.now() - 10_000);
        expect(retrying?.error).toBe('transient');
    });
});

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await Bun.sleep(5);
    }
    throw new Error('condition was not met before timeout');
}
