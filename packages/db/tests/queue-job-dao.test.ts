import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BunSqliteAdapter } from '../src/adapters/bun-sqlite';
import { QueueJobDao } from '../src/queue-job-dao';

let adapter: BunSqliteAdapter;
let dao: QueueJobDao;

beforeAll(async () => {
    adapter = new BunSqliteAdapter({ databaseUrl: ':memory:' });
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
    dao = new QueueJobDao(adapter.getDb());
});

afterAll(() => {
    adapter.close();
});

describe('QueueJobDao', () => {
    test('enqueue creates a pending job', async () => {
        const id = await dao.enqueue('test', { key: 'value' });
        expect(id).toBeTruthy();
        const job = await dao.getById(id);
        expect(job?.type).toBe('test');
        expect(job?.status).toBe('pending');
        expect(job?.attempts).toBe(0);
        expect(job?.maxRetries).toBe(3);
        expect(JSON.parse(job?.payload ?? '{}')).toEqual({ key: 'value' });
    });

    test('enqueue with custom options', async () => {
        const id = await dao.enqueue('delayed', {}, { maxRetries: 5, delay: 10000 });
        const job = await dao.getById(id);
        expect(job?.maxRetries).toBe(5);
        expect(job?.nextRetryAt).toBeGreaterThan(0);
    });

    test('enqueue with TTL', async () => {
        const id = await dao.enqueue('ttl', {}, { ttlMs: 60000 });
        const job = await dao.getById(id);
        expect(job?.expiresAt).toBeGreaterThan(0);
    });

    test('enqueueBatch creates multiple jobs', async () => {
        const ids = await dao.enqueueBatch([
            { type: 'batch1', payload: 1 },
            { type: 'batch2', payload: 2 },
            { type: 'batch3', payload: 3 },
        ]);
        expect(ids).toHaveLength(3);
        for (const id of ids) {
            const job = await dao.getById(id);
            expect(job?.status).toBe('pending');
        }
    });

    test('getById returns undefined for missing job', async () => {
        const job = await dao.getById('nonexistent');
        expect(job).toBeUndefined();
    });

    test('getStats returns aggregate counts', async () => {
        const stats = await dao.getStats();
        expect(stats.pending).toBeGreaterThan(0);
        expect(typeof stats.processing).toBe('number');
        expect(typeof stats.completed).toBe('number');
        expect(typeof stats.failed).toBe('number');
    });

    test('countByStatus returns count', async () => {
        const c = await dao.countByStatus('pending');
        expect(c).toBeGreaterThan(0);
    });

    test('findPending returns ready jobs', async () => {
        const jobs = await dao.findPending(10);
        expect(jobs.length).toBeGreaterThan(0);
        for (const j of jobs) {
            expect(j.status).toBe('pending');
        }
    });

    test('claimReady atomically claims jobs', async () => {
        const claimed = await dao.claimReady(2);
        expect(claimed.length).toBeGreaterThan(0);
        for (const j of claimed) {
            expect(j.status).toBe('processing');
            expect(j.processingAt).toBeGreaterThan(0);
        }
    });

    test('markProcessing transitions jobs to processing', async () => {
        const id = await dao.enqueue('processing-test', {});
        await dao.markProcessing([id]);
        const job = await dao.getById(id);
        expect(job?.status).toBe('processing');
    });

    test('markProcessing with empty array is no-op', async () => {
        await dao.markProcessing([]);
        // No error thrown
    });

    test('markCompleted transitions job to completed', async () => {
        const id = await dao.enqueue('complete-me', {});
        await dao.markProcessing([id]);
        await dao.markCompleted(id);
        const job = await dao.getById(id);
        expect(job?.status).toBe('completed');
    });

    test('markFailed transitions job to failed', async () => {
        const id = await dao.enqueue('fail-me', {});
        await dao.markFailed(id, 1, 'test error');
        const job = await dao.getById(id);
        expect(job?.status).toBe('failed');
        expect(job?.attempts).toBe(1);
        expect(job?.lastError).toBe('test error');
    });

    test('markForRetry resets job to pending', async () => {
        const id = await dao.enqueue('retry-me', {});
        const retryAt = Date.now() + 10000;
        await dao.markForRetry(id, 2, 'retry error', retryAt);
        const job = await dao.getById(id);
        expect(job?.status).toBe('pending');
        expect(job?.attempts).toBe(2);
        expect(job?.lastError).toBe('retry error');
        expect(job?.nextRetryAt).toBe(retryAt);
    });

    test('resetStuckJobs resets stuck processing jobs', async () => {
        const id = await dao.enqueue('stuck-test', {});
        await dao.markProcessing([id]);
        // Set processingAt to 10 seconds ago via raw query
        const past = Date.now() - 10000;
        await adapter.run('UPDATE queue_jobs SET processing_at = ? WHERE id = ?', past, id);

        const count = await dao.resetStuckJobs(5000);
        expect(count).toBeGreaterThanOrEqual(1);

        const job = await dao.getById(id);
        expect(job?.status).toBe('pending');
    });

    test('failExpiredJobs fails expired pending jobs', async () => {
        const now = Date.now();
        const expiredId = await dao.enqueue('expired', {}, { ttlMs: -1 }); // already expired
        // Force expires_at into the past
        await adapter.run('UPDATE queue_jobs SET expires_at = ? WHERE id = ?', now - 1, expiredId);
        await adapter.run('UPDATE queue_jobs SET status = ? WHERE id = ?', 'pending', expiredId);

        const count = await dao.failExpiredJobs();
        expect(count).toBeGreaterThanOrEqual(1);

        const job = await dao.getById(expiredId);
        expect(job?.status).toBe('failed');
        expect(job?.lastError).toContain('expired');
    });

    test('claimReady with zero batchSize returns empty', async () => {
        const claimed = await dao.claimReady(0);
        expect(claimed).toEqual([]);
    });
});
