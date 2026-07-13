import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { applyMigrations } from '@gobing-ai/ts-db';
import { BunSqliteAdapter } from '@gobing-ai/ts-db/bun-sqlite';
import { InboxMessageDao, type InboxMessageEvents } from '@gobing-ai/ts-db/inbox';
import type { BusLifecycleEvents } from '@gobing-ai/ts-infra';
import { EventBus } from '@gobing-ai/ts-infra';
import type { MessageStore } from '../src';

/** Compile-time proof that `InboxMessageDao` satisfies the ai-runner-owned port. */
const assertMessageStore: (dao: InboxMessageDao) => MessageStore = (dao) => dao;

/**
 * R5: A higher-layer `EventBus<InboxMessageEvents>` with a lifecycle bus
 * produces `bus.emit.done` breadcrumbs when passed directly as the DAO's
 * structural sink — no adapter class, no `MessageService`.
 */
describe('InboxMessageDao — lifecycle-bus integration (R5)', () => {
    let adapter: BunSqliteAdapter;

    beforeAll(async () => {
        adapter = new BunSqliteAdapter({ databaseUrl: ':memory:' });
        await applyMigrations(adapter, {
            migrationsFolder: '/nonexistent',
            logger: { info: () => {}, warn: () => {}, error: () => {} },
        });
    });

    afterAll(() => {
        adapter.close();
    });

    test('message.enqueued produces bus.emit.done breadcrumb on the lifecycle bus', async () => {
        const events: string[] = [];
        const payloads: unknown[] = [];
        const lifecycleBus = new EventBus<BusLifecycleEvents>();
        lifecycleBus.on('bus.emit.done', (d) => {
            events.push(d.event);
            payloads.push(d.detail);
        });

        const bus = new EventBus<InboxMessageEvents>({ lifecycleBus });
        const dao = new InboxMessageDao(adapter, { events: bus });

        await dao.enqueue('alice', 'bob', 'hello from R5');

        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events).toContain('message.enqueued');
        expect(JSON.stringify(payloads)).not.toContain('hello from R5');
    });

    test('InboxMessageDao structurally satisfies MessageStore (R5/R7)', () => {
        const dao = new InboxMessageDao(adapter);
        const store: MessageStore = assertMessageStore(dao);
        expect(store).toBe(dao);
        expect(typeof store.enqueue).toBe('function');
        expect(typeof store.drainPending).toBe('function');
        expect(typeof store.markDelivered).toBe('function');
        expect(typeof store.markFailed).toBe('function');
    });

    test('message.delivered produces bus.emit.done breadcrumb on the lifecycle bus', async () => {
        const events: string[] = [];
        const lifecycleBus = new EventBus<BusLifecycleEvents>();
        lifecycleBus.on('bus.emit.done', (d) => events.push(d.event));

        const bus = new EventBus<InboxMessageEvents>({ lifecycleBus });
        const dao = new InboxMessageDao(adapter, { events: bus });

        const id = await dao.enqueue('planner', 'coder', 'deliver this');
        await dao.markDelivered(id);

        expect(events.length).toBeGreaterThanOrEqual(2); // enqueue + delivered
        expect(events).toContain('message.delivered');
    });
});
