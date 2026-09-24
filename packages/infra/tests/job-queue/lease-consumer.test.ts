import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDbAdapter, type DbAdapter, QueueJobDao } from '@gobing-ai/ts-db';
import { EventBus } from '../../src/event-bus/event-bus';
import type { QueueEvents } from '../../src/events';
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

    test('AC8: waiting rows are never claimed out from under the active cycle (task 0086 R6)', async () => {
        const queue = new DBJobQueue(dao);
        const first = await queue.enqueue('slow-a', {});
        const second = await queue.enqueue('slow-b', {});
        const ran: string[] = [];

        // Consumer A: concurrency 1, so a cycle holds one job at a time; the
        // 400ms handler outlives B's 50ms polls, so B must keep off job one.
        const a = new DBQueueConsumer(dao, { batchSize: 2, maxConcurrency: 1, visibilityTimeout: 150 });
        const b = new DBQueueConsumer(dao, { batchSize: 2, maxConcurrency: 1, visibilityTimeout: 150 });
        const track = (name: string) => async (job: { id: string }) => {
            ran.push(`${name}:${job.id}`);
            if (job.id === first) await sleep(400);
        };
        a.register('slow-a', track('A'));
        a.register('slow-b', track('A'));
        b.register('slow-a', track('B'));
        b.register('slow-b', track('B'));

        const cycleA = a.processOnce();
        for (let i = 0; i < 6; i++) {
            await sleep(50);
            await b.processOnce();
        }
        await cycleA;
        await a.stop();

        // Each handler ran exactly once in total.
        expect(ran.filter((entry) => entry.startsWith(`A:${first}`)).length).toBe(1);
        expect(ran.filter((entry) => entry.endsWith(first)).length).toBe(1);
        expect(ran.filter((entry) => entry.endsWith(second)).length).toBe(1);
        expect((await dao.getById(first))?.status).toBe('completed');
        expect((await dao.getById(second))?.status).toBe('completed');
    });

    test('AC9: stop() halts further claims within a cycle; manual drains still work (task 0086 R6)', async () => {
        const queue = new DBJobQueue(dao);
        const ids = await Promise.all([
            queue.enqueue('stop-a', {}),
            queue.enqueue('stop-b', {}),
            queue.enqueue('stop-c', {}),
            queue.enqueue('stop-d', {}),
        ]);

        const consumer = new DBQueueConsumer(dao, { batchSize: 4, maxConcurrency: 1, drainTimeoutMs: 30 });
        consumer.register('stop-a', async () => {
            await sleep(120); // hold the cycle while stop() lands
        });
        for (const type of ['stop-b', 'stop-c', 'stop-d']) consumer.register(type, async () => {});

        const cycle = consumer.processOnce();
        await sleep(40); // first handler is in-flight now
        await consumer.stop(); // bounded: returns while the handler still runs
        await cycle;

        // No further jobs moved to processing after the first settled.
        const rows = await Promise.all(ids.map((id) => dao.getById(id)));
        expect(rows[0]?.status).toBe('completed');
        for (const row of rows.slice(1)) {
            expect(row?.status).toBe('pending');
            expect(row?.attemptToken).toBeNull();
        }

        // A never-started consumer still drains everything.
        const fresh = new DBQueueConsumer(dao, { batchSize: 4, maxConcurrency: 4 });
        for (const type of ['stop-a', 'stop-b', 'stop-c', 'stop-d']) fresh.register(type, async () => {});
        expect(await fresh.processOnce()).toBe(3);
        const after = await Promise.all(ids.map((id) => dao.getById(id)));
        expect(after.map((row) => row?.status)).toEqual(['completed', 'completed', 'completed', 'completed']);
    });

    test('AC10: a handler-failed job ends failed after exactly maxRetries total attempts (task 0086 R7)', async () => {
        const queue = new DBJobQueue(dao);
        const id = await queue.enqueue('crash', {}, { maxRetries: 3 });
        let attempts = 0;
        const consumer = new DBQueueConsumer(dao, {
            visibilityTimeout: 60_000,
            baseDelay: 1,
            maxDelay: 2,
        });
        consumer.register('crash', async () => {
            attempts += 1;
            throw new Error(`boom ${attempts}`);
        });

        for (let i = 0; i < 3; i++) {
            await consumer.processOnce();
            await sleep(5); // nextRetryAt = now + 1..2ms
        }

        expect(attempts).toBe(3);
        const row = await dao.getById(id);
        expect(row?.status).toBe('failed');
        expect(row?.attempts).toBe(3);
        expect(row?.lastError).toBe('boom 3');
    });

    test('R10: a stolen attempt emits no completed or failed events (task 0086)', async () => {
        const queue = new DBJobQueue(dao);
        const bus = new EventBus<QueueEvents>();
        const events: string[] = [];
        for (const name of ['queue.job.completed', 'queue.job.failed', 'queue.job.retrying'] as const) {
            bus.on(name, () => events.push(name));
        }

        // Completed path: the handler steals its own token mid-run.
        const completedId = await queue.enqueue('steal-ok', {}, { timeoutMs: null });
        const stealConsumer = new DBQueueConsumer(dao, { visibilityTimeout: 60_000, events: bus, queueName: 'steal' });
        stealConsumer.register('steal-ok', async (job) => {
            await adapter.run(`UPDATE queue_jobs SET lease_expires_at = ? WHERE id = ?`, Date.now() - 1, job.id);
            await dao.claimReady(1, { leaseMs: 60_000 }); // rival mints a fresh token
        });
        await stealConsumer.processOnce();

        const completedRow = await dao.getById(completedId);
        expect(completedRow?.status).toBe('processing'); // rival still owns it
        expect(events).toEqual([]); // the fenced acknowledgement emitted nothing

        // Failed path: same steal, but the handler throws.
        events.length = 0;
        const failedId = await queue.enqueue('steal-fail', {}, { timeoutMs: null, maxRetries: 5 });
        const failConsumer = new DBQueueConsumer(dao, { visibilityTimeout: 60_000, events: bus, queueName: 'steal' });
        failConsumer.register('steal-fail', async (job) => {
            await adapter.run(`UPDATE queue_jobs SET lease_expires_at = ? WHERE id = ?`, Date.now() - 1, job.id);
            await dao.claimReady(1, { leaseMs: 60_000 });
            throw new Error('stale failure');
        });
        await failConsumer.processOnce();

        expect(events).toEqual([]); // markFailed/markForRetry were fenced — no events
        expect((await dao.getById(failedId))?.status).toBe('processing');
    });
});
