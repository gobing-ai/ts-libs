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

    test('emits queue lifecycle events through the injected bus', async () => {
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
});

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await Bun.sleep(5);
    }
    throw new Error('condition was not met before timeout');
}
