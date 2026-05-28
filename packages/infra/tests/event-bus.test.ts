import { describe, expect, test } from 'bun:test';
import { EventBus } from '../src/event-bus/event-bus';
import { setLoggerMuted } from '../src/logger';

setLoggerMuted(true);

type TestEvents = {
    'user.created': (id: string, name: string) => void;
    'user.deleted': (id: string) => void;
    'data.synced': (count: number) => void;
};

describe('EventBus', () => {
    test('registers and emits sync handlers', async () => {
        const bus = new EventBus<TestEvents>();
        const calls: string[] = [];

        bus.on('user.created', (id, name) => {
            calls.push(`created:${id}:${name}`);
        });

        await bus.emit('user.created', 'u1', 'Alice');
        expect(calls).toEqual(['created:u1:Alice']);
    });

    test('handles multiple handlers for same event', async () => {
        const bus = new EventBus<TestEvents>();
        const calls: string[] = [];

        bus.on('data.synced', (count) => calls.push(`a:${count}`));
        bus.on('data.synced', (count) => calls.push(`b:${count}`));

        await bus.emit('data.synced', 42);
        expect(calls).toEqual(['a:42', 'b:42']);
    });

    test('once handler fires exactly once', async () => {
        const bus = new EventBus<TestEvents>();
        let count = 0;

        bus.once('user.deleted', () => {
            count++;
        });

        await bus.emit('user.deleted', 'u1');
        await bus.emit('user.deleted', 'u2');
        expect(count).toBe(1);
    });

    test('off removes handler', async () => {
        const bus = new EventBus<TestEvents>();
        let count = 0;

        const handler = () => {
            count++;
        };
        bus.on('user.deleted', handler);
        await bus.emit('user.deleted', 'u1');
        expect(count).toBe(1);

        bus.off('user.deleted', handler);
        await bus.emit('user.deleted', 'u2');
        expect(count).toBe(1);
    });

    test('removeAllListeners clears all handlers', async () => {
        const bus = new EventBus<TestEvents>();
        let count = 0;
        bus.on('user.created', () => {
            count++;
        });
        bus.on('user.deleted', () => {
            count++;
        });

        bus.removeAllListeners();
        await bus.emit('user.created', 'u1', 'test');
        await bus.emit('user.deleted', 'u1');
        expect(count).toBe(0);
    });

    test('removeAllListeners for specific event', async () => {
        const bus = new EventBus<TestEvents>();
        let created = 0;
        let deleted = 0;
        bus.on('user.created', () => {
            created++;
        });
        bus.on('user.deleted', () => {
            deleted++;
        });

        bus.removeAllListeners('user.created');
        await bus.emit('user.created', 'u1', 'test');
        await bus.emit('user.deleted', 'u1');
        expect(created).toBe(0);
        expect(deleted).toBe(1);
    });

    test('emit handles handler errors gracefully', async () => {
        const bus = new EventBus<TestEvents>();
        let secondFired = false;

        bus.on('data.synced', () => {
            throw new Error('boom');
        });
        bus.on('data.synced', () => {
            secondFired = true;
        });

        await bus.emit('data.synced', 1);
        expect(secondFired).toBeTrue();
    });

    test('listenerCount returns correct counts', () => {
        const bus = new EventBus<TestEvents>();
        bus.on('user.created', () => {});
        bus.on('user.created', () => {});

        expect(bus.listenerCount('user.created')).toBe(2);
        expect(bus.listenerCount('user.deleted')).toBe(0);
    });

    test('eventNames returns all registered event names', () => {
        const bus = new EventBus<TestEvents>();
        bus.on('user.created', () => {});
        bus.on('data.synced', () => {});

        const names = bus.eventNames().sort();
        expect(names).toContain('user.created');
        expect(names).toContain('data.synced');
    });

    test('async handlers with empty args', async () => {
        const bus = new EventBus<TestEvents>();
        let fired = false;
        bus.on('user.deleted', () => {
            fired = true;
        });
        await bus.emit('user.deleted', 'u1');
        expect(fired).toBeTrue();
    });
});
