import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDbAdapter, type DbAdapter, QueueJobDao } from '@gobing-ai/ts-db';
import { DBJobQueue, DBQueueConsumer } from '../../src/job-queue';

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
});

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await Bun.sleep(5);
    }
    throw new Error('condition was not met before timeout');
}
