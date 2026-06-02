import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { BunSqliteAdapter } from '../src/adapters/bun-sqlite';
import { InboxMessageDao } from '../src/inbox-message-dao';

let adapter: BunSqliteAdapter;
let dao: InboxMessageDao;

beforeEach(async () => {
    adapter = new BunSqliteAdapter({ databaseUrl: ':memory:' });
    await adapter.exec(`CREATE TABLE inbox_messages (
        id TEXT PRIMARY KEY,
        from_id TEXT,
        to_id TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        in_reply_to TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER,
        inject_attempts INTEGER NOT NULL DEFAULT 0,
        inject_error TEXT
    )`);
    await adapter.exec('CREATE INDEX idx_inbox_messages_to_status ON inbox_messages (to_id, status)');
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
