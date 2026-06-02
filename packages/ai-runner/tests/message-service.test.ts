import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { BunSqliteAdapter } from '@gobing-ai/ts-db/bun-sqlite';
import { InboxMessageDao } from '@gobing-ai/ts-db/inbox';
import { MessageService } from '../src';

let adapter: BunSqliteAdapter;
let service: MessageService;

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
    service = new MessageService(new InboxMessageDao(adapter));
});

afterEach(() => {
    adapter.close();
});

describe('MessageService', () => {
    test('enqueue, drain and deliver cycle updates pending count', async () => {
        const id = await service.enqueue(null, 'coder', 'hello');
        expect(await service.countPending('coder')).toBe(1);
        const drained = await service.drain('coder');
        expect(drained).toHaveLength(1);
        expect(drained[0]?.id).toBe(id);
        const message = drained[0];
        if (message === undefined) throw new Error('Expected one drained message');
        expect(MessageService.formatMessage(message)).toBe(`[task from=operator id=${id}] hello`);
        await service.deliver(id);
        expect((await service.inbox('coder'))[0]).toMatchObject({ status: 'delivered' });
        expect(await service.countPending('coder')).toBe(0);
    });

    test('fail delegates failure lifecycle', async () => {
        const id = await service.enqueue('planner', 'coder', 'hello');
        await service.fail(id, 'stdin closed');
        expect((await service.inbox('coder'))[0]).toMatchObject({ status: 'failed', injectError: 'stdin closed' });
    });
});
