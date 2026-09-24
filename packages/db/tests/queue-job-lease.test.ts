import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { BunSqliteAdapter } from '../src/adapters/bun-sqlite';
import { QueueJobDao } from '../src/queue-job-dao';

/**
 * Lease ownership + execution-policy persistence tests (A21 / execution
 * deadlines): attempt tokens fence queue mutations, finite visibility leases
 * recover expired work, and the job execution option (`timeoutMs`) persists
 * through enqueue with explicit unlimited distinct from absence.
 */

let adapter: BunSqliteAdapter;
let dao: QueueJobDao;

beforeEach(async () => {
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
        expires_at INTEGER,
        timeout_ms INTEGER,
        timeout_unlimited INTEGER NOT NULL DEFAULT 0,
        attempt_token TEXT,
        lease_expires_at INTEGER
    )`);
    await adapter.exec('CREATE INDEX queue_jobs_ready_idx ON queue_jobs (status, next_retry_at, created_at)');
    dao = new QueueJobDao(adapter);
});

afterEach(() => {
    adapter.close();
});

describe('QueueJobDao execution-policy persistence', () => {
    test('positive timeoutMs persists as a finite job deadline', async () => {
        const id = await dao.enqueue('bounded', {}, { timeoutMs: 5_000 });
        const job = await dao.getById(id);
        expect(job?.timeoutMs).toBe(5_000);
        expect(job?.timeoutUnlimited).toBe(0);
    });

    test('explicit null persists unlimited distinctly from absence', async () => {
        const unlimited = await dao.enqueue('unlimited', {}, { timeoutMs: null });
        const absent = await dao.enqueue('absent', {});

        const unlimitedJob = await dao.getById(unlimited);
        expect(unlimitedJob?.timeoutMs).toBeNull();
        expect(unlimitedJob?.timeoutUnlimited).toBe(1);

        const absentJob = await dao.getById(absent);
        expect(absentJob?.timeoutMs).toBeNull();
        expect(absentJob?.timeoutUnlimited).toBe(0);
    });

    test('enqueueBatch persists per-job timeout policies', async () => {
        const ids = await dao.enqueueBatch([
            { type: 'a', payload: 1, timeoutMs: 1_000 },
            { type: 'b', payload: 2, timeoutMs: null },
            { type: 'c', payload: 3 },
        ]);
        const [a, b, c] = await Promise.all(ids.map((id) => dao.getById(id)));
        expect(a?.timeoutMs).toBe(1_000);
        expect(b?.timeoutUnlimited).toBe(1);
        expect(c?.timeoutUnlimited).toBe(0);
    });

    test('invalid explicit timeoutMs is rejected before insert', async () => {
        for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            await expect(dao.enqueue('bad', {}, { timeoutMs: invalid })).rejects.toThrow(RangeError);
        }
        const stats = await dao.getStats();
        expect(stats.pending).toBe(0);
    });
});

describe('QueueJobDao lease ownership', () => {
    test('claimReady mints a fresh attempt token and lease expiry per claim', async () => {
        const id = await dao.enqueue('leased', {});
        const [claimed] = await dao.claimReady(1, { leaseMs: 1_000 });

        expect(claimed?.id).toBe(id);
        expect(claimed?.attemptToken).toBeTruthy();
        expect(claimed?.leaseExpiresAt).toBeGreaterThan(Date.now());

        // A second claim mints a different token — but only after the lease expires.
        await expect(dao.claimReady(1, { leaseMs: 1_000 })).resolves.toEqual([]);
    });

    test('legacy claims (no leaseMs) mint no token and stay recoverable via the age sweep', async () => {
        const id = await dao.enqueue('legacy-claim', {});
        const [claimed] = await dao.claimReady(1);
        expect(claimed?.attemptToken).toBeNull();
        expect(claimed?.leaseExpiresAt).toBeNull();

        // Crash simulation: without ownership markers the stuck row must be
        // recoverable through the legacy sweep, not orphaned forever.
        expect(await dao.resetStuckJobs(0)).toBe(1);
        const recovered = await dao.getById(id);
        expect(recovered?.status).toBe('pending');
        expect(recovered?.attemptToken).toBeNull();

        // Reclaiming an expired-lease row with a legacy claim clears its stale
        // ownership markers so the row also falls back to the legacy path.
        const [leased] = await dao.claimReady(1, { leaseMs: 0 });
        expect(leased?.attemptToken).toBeTruthy();
        await new Promise((resolve) => setTimeout(resolve, 2));
        const [legacyReclaim] = await dao.claimReady(1);
        expect(legacyReclaim?.id).toBe(leased?.id);
        expect(legacyReclaim?.attemptToken).toBeNull();
        expect(legacyReclaim?.leaseExpiresAt).toBeNull();
    });

    test('renewLease extends expiry for the owning token and refuses foreign tokens', async () => {
        const id = await dao.enqueue('renew', {});
        const [claimed] = await dao.claimReady(1, { leaseMs: 1_000 });
        const token = claimed?.attemptToken as string;

        expect(await dao.renewLease(id, token, 60_000)).toBe(true);
        const renewed = await dao.getById(id);
        expect(renewed?.leaseExpiresAt).toBeGreaterThan(Date.now() + 30_000);

        expect(await dao.renewLease(id, 'foreign-token', 60_000)).toBe(false);
    });

    test('expired-lease processing work is recoverable with a fresh token', async () => {
        const id = await dao.enqueue('lost-worker', {});
        const [first] = await dao.claimReady(1, { leaseMs: 1 });
        const firstToken = first?.attemptToken as string;

        // Simulate worker loss: let the lease expire, then recover.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const [recovered] = await dao.claimReady(1, { leaseMs: 1_000 });

        expect(recovered?.id).toBe(id);
        expect(recovered?.attemptToken).toBeTruthy();
        expect(recovered?.attemptToken).not.toBe(firstToken);
        expect(recovered?.status).toBe('processing');
    });

    test('stale attempt cannot renew, complete, fail, or retry a replacement attempt', async () => {
        const id = await dao.enqueue('stale', {});
        const [first] = await dao.claimReady(1, { leaseMs: 1 });
        const staleToken = first?.attemptToken as string;

        await new Promise((resolve) => setTimeout(resolve, 5));
        const [replacement] = await dao.claimReady(1, { leaseMs: 60_000 });
        const freshToken = replacement?.attemptToken as string;

        expect(await dao.renewLease(id, staleToken, 60_000)).toBe(false);
        expect(await dao.markCompleted(id, staleToken)).toBe(false);
        expect(await dao.markFailed(id, 1, 'stale failure', staleToken)).toBe(false);
        expect(await dao.markForRetry(id, 1, 'stale retry', Date.now(), staleToken)).toBe(false);

        const row = await dao.getById(id);
        expect(row?.status).toBe('processing');
        expect(row?.attemptToken).toBe(freshToken);
        expect(row?.lastError).toBeNull();
    });

    test('current-token acknowledgements apply and clear ownership fields', async () => {
        const completedId = await dao.enqueue('ack-complete', {});
        const [claimedComplete] = await dao.claimReady(1, { leaseMs: 60_000 });
        expect(await dao.markCompleted(completedId, claimedComplete?.attemptToken as string)).toBe(true);
        const completed = await dao.getById(completedId);
        expect(completed?.status).toBe('completed');
        expect(completed?.attemptToken).toBeNull();
        expect(completed?.leaseExpiresAt).toBeNull();

        const retriedId = await dao.enqueue('ack-retry', {}, { maxRetries: 5 });
        const [claimedRetry] = await dao.claimReady(1, { leaseMs: 60_000 });
        const retryToken = claimedRetry?.attemptToken;
        if (retryToken === undefined || retryToken === null) throw new Error('claim must mint a token');
        expect(await dao.markForRetry(retriedId, 1, 'boom', Date.now() + 10, retryToken)).toBe(true);
        const retried = await dao.getById(retriedId);
        expect(retried?.status).toBe('pending');
        expect(retried?.attemptToken).toBeNull();
    });

    test('age-based stuck reset skips leased attempts but still resets legacy rows', async () => {
        const leasedId = await dao.enqueue('leased-live', {});
        await dao.claimReady(1, { leaseMs: 60_000 });

        const legacyId = await dao.enqueue('legacy-row', {});
        await adapter.run(
            `UPDATE queue_jobs SET status = 'processing', processing_at = ?,
             attempt_token = NULL, lease_expires_at = NULL WHERE id = ?`,
            Date.now() - 60_000,
            legacyId,
        );

        const reset = await dao.resetStuckJobs(30_000);
        expect(reset).toBe(1);

        const leased = await dao.getById(leasedId);
        expect(leased?.status).toBe('processing');
        expect(leased?.attemptToken).toBeTruthy();

        const legacy = await dao.getById(legacyId);
        expect(legacy?.status).toBe('pending');
    });

    test('legacy unconditional acknowledgements without a token still apply', async () => {
        const id = await dao.enqueue('legacy-ack', {});
        await dao.claimReady(1, { leaseMs: 60_000 });

        expect(await dao.markCompleted(id)).toBe(true);
        expect((await dao.getById(id))?.status).toBe('completed');
    });

    test('R7: reclaiming an expired lease counts as an attempt (task 0086)', async () => {
        const id = await dao.enqueue('reclaim-attempt', {});
        await dao.claimReady(1, { leaseMs: 1 });
        await new Promise((resolve) => setTimeout(resolve, 5));

        const [reclaimed] = await dao.claimReady(1, { leaseMs: 60_000 });
        expect(reclaimed?.id).toBe(id);
        // SQLite evaluates SET against the pre-update row: status still reads
        // 'processing' in the CASE, so the reclaim increments.
        expect(reclaimed?.attempts).toBe(1);
    });

    test('R7: a fresh pending claim does not increment attempts (task 0086)', async () => {
        const id = await dao.enqueue('fresh-claim', {});
        const [claimed] = await dao.claimReady(1, { leaseMs: 60_000 });
        expect(claimed?.id).toBe(id);
        expect(claimed?.attempts).toBe(0);
    });

    test('R7: an expired lease on its last attempt fails the job instead of reclaiming (task 0086)', async () => {
        const id = await dao.enqueue('exhausted-lease', {}, { maxRetries: 1 });
        await dao.claimReady(1, { leaseMs: 1 });
        await new Promise((resolve) => setTimeout(resolve, 5));

        const claimed = await dao.claimReady(1, { leaseMs: 60_000 });
        expect(claimed).toEqual([]); // exhaustion sweep removed it from reclaimable

        const row = await dao.getById(id);
        expect(row?.status).toBe('failed');
        expect(row?.attempts).toBe(1);
        expect(row?.lastError).toBe('lease expired: attempts exhausted');
        expect(row?.attemptToken).toBeNull();
        expect(row?.processingAt).toBeNull();
    });

    test('R7: stuck legacy row on its last attempt fails via the age sweep (task 0086)', async () => {
        const id = await dao.enqueue('exhausted-stuck', {}, { maxRetries: 2 });
        await adapter.run(
            `UPDATE queue_jobs SET status = 'processing', processing_at = ?, attempts = 1,
             attempt_token = NULL, lease_expires_at = NULL WHERE id = ?`,
            Date.now() - 60_000,
            id,
        );

        expect(await dao.resetStuckJobs(30_000)).toBe(0);
        const row = await dao.getById(id);
        expect(row?.status).toBe('failed');
        expect(row?.attempts).toBe(2);
        expect(row?.lastError).toBe('stuck job: attempts exhausted');
    });

    test('R7: stuck legacy reset below exhaustion increments attempts and requeues (task 0086)', async () => {
        const id = await dao.enqueue('stuck-counts', {}, { maxRetries: 5 });
        await adapter.run(
            `UPDATE queue_jobs SET status = 'processing', processing_at = ?, attempts = 1,
             attempt_token = NULL, lease_expires_at = NULL WHERE id = ?`,
            Date.now() - 60_000,
            id,
        );

        expect(await dao.resetStuckJobs(30_000)).toBe(1);
        const row = await dao.getById(id);
        expect(row?.status).toBe('pending');
        expect(row?.attempts).toBe(2); // the stuck attempt was consumed
    });
});
