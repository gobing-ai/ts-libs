import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { BunSqliteAdapter } from '../src/adapters/bun-sqlite';
import { InboxMessageDao, type InboxMessageEventSink, type InboxMessageEvents } from '../src/inbox-message-dao';
import { applyMigrations } from '../src/migrate';

const silentMigrationLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
};

async function migrateInboxDatabase(adapter: BunSqliteAdapter): Promise<void> {
    await applyMigrations(adapter, {
        migrationsFolder: '/nonexistent',
        logger: silentMigrationLogger,
    });
}

let adapter: BunSqliteAdapter;
let dao: InboxMessageDao;

beforeEach(async () => {
    adapter = new BunSqliteAdapter({ databaseUrl: ':memory:' });
    await migrateInboxDatabase(adapter);
    dao = new InboxMessageDao(adapter);
});

afterEach(() => {
    adapter.close();
});

describe('InboxMessageDao', () => {
    test('enqueue creates queued message and countPending reports it', async () => {
        const id = await dao.enqueue(null, 'coder', 'please inspect');
        const message = await dao.getById(id);
        expect(message).toMatchObject({
            id,
            fromId: null,
            toId: 'coder',
            body: 'please inspect',
            status: 'queued',
            injectAttempts: 0,
        });
        expect(await dao.countPending('coder')).toBe(1);
    });

    test('drainPending atomically marks queued messages injected', async () => {
        const first = await dao.enqueue('planner', 'coder', 'first');
        await dao.enqueue('planner', 'coder', 'second', first);
        await dao.enqueue('planner', 'reviewer', 'not yours');

        const drained = await dao.drainPending('coder');
        expect(drained.map((message) => message.body)).toEqual(['first', 'second']);
        expect(drained.every((message) => message.status === 'injected')).toBeTrue();
        expect(drained.every((message) => message.injectAttempts === 1)).toBeTrue();
        expect(await dao.countPending('coder')).toBe(0);
        expect(await dao.countPending('reviewer')).toBe(1);
    });

    test('markDelivered and markFailed update lifecycle columns', async () => {
        const deliveredId = await dao.enqueue('planner', 'coder', 'done?');
        await dao.markDelivered(deliveredId);
        expect(await dao.getById(deliveredId)).toMatchObject({ status: 'delivered' });
        expect((await dao.getById(deliveredId))?.deliveredAt).toBeGreaterThan(0);

        const failedId = await dao.enqueue('planner', 'coder', 'try');
        await dao.markFailed(failedId, 'stdin closed');
        expect(await dao.getById(failedId)).toMatchObject({ status: 'failed', injectError: 'stdin closed' });
    });

    test('inbox lists one agent messages newest first with paging', async () => {
        await dao.enqueue('a', 'coder', 'old');
        await Bun.sleep(1);
        await dao.enqueue('b', 'coder', 'new');
        await dao.enqueue('a', 'reviewer', 'hidden');

        const firstPage = await dao.inbox('coder', 1);
        expect(firstPage.map((message) => message.body)).toEqual(['new']);
        const secondPage = await dao.inbox('coder', 1, 1);
        expect(secondPage.map((message) => message.body)).toEqual(['old']);
    });

    test('concurrent enqueue assigns unique ids', async () => {
        const ids = await Promise.all(Array.from({ length: 10 }, (_, index) => dao.enqueue('p', 'coder', `m${index}`)));
        expect(new Set(ids).size).toBe(ids.length);
        expect(await dao.countPending('coder')).toBe(10);
    });
});

// ---------------------------------------------------------------------------
// Event sink tests (R4)
// ---------------------------------------------------------------------------

class RecordingSink implements InboxMessageEventSink {
    readonly events: { event: string; detail: unknown }[] = [];

    emit<K extends keyof InboxMessageEvents>(event: K, ...args: Parameters<InboxMessageEvents[K]>): void {
        this.events.push({ event, detail: args[0] });
    }
}

class ThrowingSink implements InboxMessageEventSink {
    emit<K extends keyof InboxMessageEvents>(_event: K, ..._args: Parameters<InboxMessageEvents[K]>): void {
        throw new Error('sink unavailable');
    }
}

class RejectingSink implements InboxMessageEventSink {
    async emit<K extends keyof InboxMessageEvents>(
        _event: K,
        ..._args: Parameters<InboxMessageEvents[K]>
    ): Promise<void> {
        throw new Error('async sink unavailable');
    }
}

describe('InboxMessageDao — event sink (R4)', () => {
    let adapter: BunSqliteAdapter;
    let sink: RecordingSink;
    let dao: InboxMessageDao;

    beforeEach(async () => {
        adapter = new BunSqliteAdapter({ databaseUrl: ':memory:' });
        await migrateInboxDatabase(adapter);
        sink = new RecordingSink();
        dao = new InboxMessageDao(adapter, { events: sink });
    });

    afterEach(() => {
        adapter.close();
    });

    test('enqueue emits message.enqueued with full payload', async () => {
        const id = await dao.enqueue('alice', 'bob', 'hello', 'msg-1');

        expect(sink.events).toHaveLength(1);
        const emitted = sink.events[0] as { event: string; detail: Record<string, unknown> };
        expect(emitted.event).toBe('message.enqueued');
        expect(emitted.detail).toEqual({
            id,
            fromId: 'alice',
            toId: 'bob',
            inReplyTo: 'msg-1',
            timestamp: (await dao.getById(id))?.createdAt,
        });
    });

    test('enqueue without inReplyTo omits the field', async () => {
        await dao.enqueue(null, 'bob', 'hi');

        expect(sink.events).toHaveLength(1);
        const emitted = sink.events[0] as { event: string; detail: Record<string, unknown> };
        expect(emitted.event).toBe('message.enqueued');
        expect(emitted.detail.fromId).toBe(null);
        expect(emitted.detail).not.toHaveProperty('inReplyTo');
        expect(emitted.detail).not.toHaveProperty('body');
    });
    test('drainPending emits one message.injected per drained row', async () => {
        const firstId = await dao.enqueue('u1', 'coder', 'first');
        const secondId = await dao.enqueue('u2', 'coder', 'second', firstId);
        await dao.enqueue('u3', 'reviewer', 'other');

        const drained = await dao.drainPending('coder');
        expect(drained).toHaveLength(2);

        // 3 enqueues + 2 injected = 5 events total
        expect(sink.events).toHaveLength(5);
        const injected = sink.events.slice(-2);
        expect(injected.map(({ event }) => event)).toEqual(['message.injected', 'message.injected']);
        expect(injected.map(({ detail }) => detail)).toEqual(
            drained.map((message) => ({
                id: message.id,
                fromId: message.fromId,
                toId: message.toId,
                inReplyTo: message.inReplyTo,
                injectAttempts: message.injectAttempts,
                timestamp: message.updatedAt,
            })),
        );
        expect(drained.map(({ id }) => id)).toEqual([firstId, secondId]);
    });

    test('markDelivered emits message.delivered with correct fields', async () => {
        const id = await dao.enqueue('planner', 'coder', 'task done');

        await dao.markDelivered(id);

        expect(sink.events).toHaveLength(2); // enqueue + delivered
        const emitted = sink.events[1] as { event: string; detail: Record<string, unknown> };
        expect(emitted.event).toBe('message.delivered');
        expect(emitted.detail.id).toBe(id);
        expect(emitted.detail.toId).toBe('coder');
        expect(emitted.detail.fromId).toBe('planner');
        const persisted = await dao.getById(id);
        expect(emitted.detail.deliveredAt).toBe(persisted?.deliveredAt);
        expect(emitted.detail.timestamp).toBe(persisted?.deliveredAt);
    });

    test('markFailed emits message.failed with error', async () => {
        const id = await dao.enqueue('planner', 'coder', 'will fail');

        await dao.markFailed(id, 'connection reset');

        expect(sink.events).toHaveLength(2); // enqueue + failed
        const emitted = sink.events[1] as { event: string; detail: Record<string, unknown> };
        expect(emitted.event).toBe('message.failed');
        expect(emitted.detail.id).toBe(id);
        expect(emitted.detail.toId).toBe('coder');
        expect(emitted.detail.fromId).toBe('planner');
        expect(emitted.detail.error).toBe('connection reset');
        expect(emitted.detail.timestamp).toBe((await dao.getById(id))?.updatedAt);
    });

    test('construction without sink is silent — no errors, full contract preserved', async () => {
        const noSinkDao = new InboxMessageDao(adapter);

        const deliveredId = await noSinkDao.enqueue('a', 'b', 'deliver quietly');
        const failedId = await noSinkDao.enqueue('a', 'b', 'fail quietly');
        expect(await noSinkDao.countPending('b')).toBe(2);

        const drained = await noSinkDao.drainPending('b');
        expect(drained.map(({ id }) => id)).toEqual([deliveredId, failedId]);
        expect(drained.every(({ status, injectAttempts }) => status === 'injected' && injectAttempts === 1)).toBeTrue();

        await noSinkDao.markDelivered(deliveredId);
        await noSinkDao.markFailed(failedId, 'expected regression error');
        expect(await noSinkDao.getById(deliveredId)).toMatchObject({ status: 'delivered' });
        expect(await noSinkDao.getById(failedId)).toMatchObject({
            status: 'failed',
            injectError: 'expected regression error',
        });
    });

    test('throwing sink cannot reject an already-committed mutation', async () => {
        const throwingDao = new InboxMessageDao(adapter, { events: new ThrowingSink() });

        const id = await throwingDao.enqueue('a', 'b', 'persist despite observer failure');

        expect(await throwingDao.getById(id)).toMatchObject({ id, status: 'queued' });
    });

    test('rejecting sink is contained without awaiting observer completion', async () => {
        const rejectingDao = new InboxMessageDao(adapter, { events: new RejectingSink() });

        const id = await rejectingDao.enqueue('a', 'b', 'persist despite async observer failure');
        await Promise.resolve();

        expect(await rejectingDao.getById(id)).toMatchObject({ id, status: 'queued' });
    });
});
