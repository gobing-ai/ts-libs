import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDbAdapter, type DbAdapter, QueueJobDao } from '@gobing-ai/ts-db';
import { DBJobQueue, DBQueueConsumer } from '../../src/job-queue-db';
import { setLoggerMuted } from '../../src/logger';

/**
 * Consumer lease-ownership and execution-deadline tests (A21): the job policy
 * persists through enqueue, leases renew while work is live, stale attempts
 * are fenced, cancellation settles before retry, and shutdown keeps its
 * bounded / drain-to-completion policies.
 */

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
        expires_at INTEGER,
        timeout_ms INTEGER,
        timeout_unlimited INTEGER NOT NULL DEFAULT 0,
        attempt_token TEXT,
        lease_expires_at INTEGER
    )`);
    await adapter.exec('CREATE INDEX queue_jobs_ready_idx ON queue_jobs (status, next_retry_at, created_at)');
    dao = new QueueJobDao(adapter);
    setLoggerMuted(true);
});

afterEach(async () => {
    adapter.close();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('DBQueueConsumer execution deadlines', () => {
    test('rejects an invalid defaultTimeoutMs before polling', () => {
        for (const invalid of [0, -1, 2.5, Number.NaN]) {
            expect(() => new DBQueueConsumer(dao, { defaultTimeoutMs: invalid })).toThrow('defaultTimeoutMs');
        }
        expect(() => new DBQueueConsumer(dao, { defaultTimeoutMs: null })).not.toThrow();
        expect(() => new DBQueueConsumer(dao, { defaultTimeoutMs: 1_000 })).not.toThrow();
    });

    test('job timeoutMs bounds the handler, not the enqueuing caller', async () => {
        const queue = new DBJobQueue(dao);
        const id = await queue.enqueue('bounded', {}, { timeoutMs: 80 });
        const seen: { deadlineMs: number | null; aborted: boolean }[] = [];

        const consumer = new DBQueueConsumer(dao, { visibilityTimeout: 60_000, baseDelay: 1, maxDelay: 2 });
        let attempt = 0;
        consumer.register('bounded', async (_job, ctx) => {
            seen.push({ deadlineMs: ctx.deadlineMs, aborted: ctx.signal.aborted });
            if (attempt++ === 0) {
                await sleep(300); // first attempt overruns and must be cancelled at the deadline
            }
        });

        await consumer.processOnce(); // attempt 1: deadline fires
        expect(seen[0]).toEqual({ deadlineMs: 80, aborted: false });
        await sleep(10);

        const afterTimeout = await dao.getById(id);
        expect(afterTimeout?.status).toBe('pending'); // retried after settlement
        expect(afterTimeout?.lastError).toContain('execution deadline');

        await consumer.processOnce(); // attempt 2: settles inside the budget
        expect((await dao.getById(id))?.status).toBe('completed');
        expect(attempt).toBe(2);
    });

    test('explicit unlimited job ignores the consumer default', async () => {
        const queue = new DBJobQueue(dao);
        const id = await queue.enqueue('unlimited', {}, { timeoutMs: null });

        const consumer = new DBQueueConsumer(dao, { defaultTimeoutMs: 40 });
        consumer.register('unlimited', async () => {
            await sleep(120);
        });

        await consumer.processOnce();
        expect((await dao.getById(id))?.status).toBe('completed');
    });

    test('consumer default bounds jobs without an explicit policy', async () => {
        const queue = new DBJobQueue(dao);
        await queue.enqueue('inherit', {});

        const consumer = new DBQueueConsumer(dao, { defaultTimeoutMs: 50 });
        consumer.register('inherit', async (_job, ctx) => {
            await sleep(200);
            void ctx;
        });

        await consumer.processOnce();
        const stats = await queue.stats();
        // Retried after deadline settlement, not silently released.
        expect(stats.pending + stats.failed).toBe(1);
        expect(stats.processing).toBe(0);
    });

    test('renews the lease so a second consumer never claims the live attempt', async () => {
        const queue = new DBJobQueue(dao);
        const id = await queue.enqueue('long-unlimited', {}, { timeoutMs: null });

        const owner = new DBQueueConsumer(dao, { visibilityTimeout: 120 });
        owner.register('long-unlimited', async () => {
            await sleep(500);
        });
        const processing = owner.processOnce();

        const rival = new DBQueueConsumer(dao, { visibilityTimeout: 120 });
        rival.register('long-unlimited', async () => {
            throw new Error('rival must never execute the live attempt');
        });

        // Multiple visibility intervals pass while the owner keeps renewing.
        for (let i = 0; i < 4; i++) {
            await sleep(110);
            expect(await rival.processOnce()).toBe(0);
        }

        await processing;
        expect((await dao.getById(id))?.status).toBe('completed');
        await owner.stop();
    });

    test('lease renewal loss aborts the attempt and fences its acknowledgements', async () => {
        const queue = new DBJobQueue(dao);
        const id = await queue.enqueue('fenced', {}, { timeoutMs: null });

        const daoProxy = new Proxy(dao, {
            get(target, prop, receiver) {
                if (prop === 'renewLease') return () => Promise.resolve(false);
                return Reflect.get(target, prop, receiver);
            },
        });

        // Short visibility ⇒ first renewal tick fires quickly and must fail.
        const consumer = new DBQueueConsumer(daoProxy, { visibilityTimeout: 120 });
        consumer.register('fenced', async (_job, ctx) => {
            await new Promise<void>((resolve) => {
                ctx.signal.addEventListener('abort', () => resolve());
            });
        });
        const processing = consumer.processOnce();

        await processing; // resolves only when lease loss aborted the attempt

        // Fenced: no acknowledgement mutated the row despite the handler settling.
        const row = await dao.getById(id);
        expect(row?.status).toBe('processing');
        expect(row?.lastError).toBeNull();

        // The abandoned attempt becomes recoverable once its lease expires.
        await adapter.run(`UPDATE queue_jobs SET lease_expires_at = ? WHERE id = ?`, Date.now() - 1, id);
        const [recovered] = await dao.claimReady(1, { leaseMs: 60_000 });
        expect(recovered?.id).toBe(id);
        expect(recovered?.attemptToken).not.toBeNull();
    });

    test('manual cancellation settles the attempt and fails it without retry', async () => {
        const queue = new DBJobQueue(dao);
        const id = await queue.enqueue('manual', {}, { timeoutMs: null, maxRetries: 5 });

        let abortedInHandler = false;
        const consumer = new DBQueueConsumer(dao, { visibilityTimeout: 60_000 });
        consumer.register('manual', async (_job, ctx) => {
            await new Promise<void>((resolve) => {
                ctx.signal.addEventListener('abort', () => {
                    abortedInHandler = true;
                    resolve();
                });
            });
        });
        const processing = consumer.processOnce();

        await sleep(20);
        expect(await consumer.cancel(id)).toBeTrue();
        await processing;

        expect(abortedInHandler).toBeTrue();
        const row = await dao.getById(id);
        expect(row?.status).toBe('failed');
        expect(row?.lastError).toContain('cancelled');
        expect(await consumer.cancel('no-such-job')).toBeFalse();
    });

    test('drain-to-completion stop waits for the unlimited job', async () => {
        const queue = new DBJobQueue(dao);
        const id = await queue.enqueue('drain', {}, { timeoutMs: null });

        let handlerDoneAt = 0;
        const consumer = new DBQueueConsumer(dao, { drainPolicy: 'drain-to-completion' });
        consumer.register('drain', async () => {
            await sleep(150);
            handlerDoneAt = Date.now();
        });
        const processing = consumer.processOnce();
        await sleep(10);
        await consumer.stop(); // must wait past handler settlement, not expire early
        await processing;

        expect(Date.now()).toBeGreaterThanOrEqual(handlerDoneAt);
        expect((await dao.getById(id))?.status).toBe('completed');
    });

    test('bounded drain expiry leaves the running attempt owned, not released', async () => {
        const queue = new DBJobQueue(dao);
        const id = await queue.enqueue('bounded-drain', {}, { timeoutMs: null });

        const consumer = new DBQueueConsumer(dao, { drainTimeoutMs: 50 });
        consumer.register('bounded-drain', async () => {
            await sleep(250);
        });
        await consumer.start();
        const processing = consumer.processOnce();
        await sleep(10);
        const started = Date.now();
        await consumer.stop();
        expect(Date.now() - started).toBeLessThan(200); // bounded: did not wait for the handler

        await processing;
        // Worker still alive: the settled attempt is acknowledged, never dropped.
        expect((await dao.getById(id))?.status).toBe('completed');
    });
});
