import { describe, expect, test } from 'bun:test';
import { EventBus } from '../src/event-bus/event-bus';
import type { BusLifecycleEvents } from '../src/event-bus/types';
import type { JobQueue } from '../src/job-queue/types';
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

    test('on with async option registers async handler', () => {
        const bus = new EventBus<TestEvents>();
        bus.on('user.created', () => {}, { async: true });

        expect(bus.listenerCount('user.created', 'async')).toBe(1);
        expect(bus.listenerCount('user.created', 'sync')).toBe(0);
        expect(bus.listenerCount('user.created')).toBe(1);
    });

    test('once with async option fires exactly once', () => {
        const bus = new EventBus<TestEvents>();
        bus.once('user.created', () => {}, { async: true });

        expect(bus.listenerCount('user.created', 'async')).toBe(1);
        // 'once' wraps the handler so off() removes it from the async set too
    });

    test('emit with zero handlers publishes noop to lifecycle bus', async () => {
        const lifecycleCalls: Array<{ event: string; detail: unknown }> = [];
        const lifecycleBus = new EventBus<BusLifecycleEvents>();
        lifecycleBus.on('bus.emit.noop', (detail) => {
            lifecycleCalls.push({ event: 'bus.emit.noop', detail });
        });

        const bus = new EventBus<TestEvents>({ lifecycleBus });
        await bus.emit('user.created', 'u1', 'Alice');

        expect(lifecycleCalls.length).toBe(1);
        const call = lifecycleCalls[0] as { event: string; detail: unknown };
        expect(call.event).toBe('bus.emit.noop');
        expect((call.detail as { event: string }).event).toBe('user.created');
    });

    test('emit publishes emit.done to lifecycle bus', async () => {
        const lifecycleCalls: Array<{ event: string; detail: unknown }> = [];
        const lifecycleBus = new EventBus<BusLifecycleEvents>();
        lifecycleBus.on('bus.emit.done', (detail) => {
            lifecycleCalls.push({ event: 'bus.emit.done', detail });
        });

        const bus = new EventBus<TestEvents>({ lifecycleBus });
        bus.on('user.created', () => {});
        await bus.emit('user.created', 'u1', 'Alice');

        expect(lifecycleCalls.length).toBe(1);
        const call = lifecycleCalls[0] as { event: string; detail: unknown };
        expect(call.event).toBe('bus.emit.done');
        const detail = call.detail as { event: string; syncCount: number };
        expect(detail.event).toBe('user.created');
        expect(detail.syncCount).toBe(1);
    });

    test('emit publishes handler.error to lifecycle bus on sync handler error', async () => {
        const lifecycleCalls: Array<{ event: string; detail: unknown }> = [];
        const lifecycleBus = new EventBus<BusLifecycleEvents>();
        lifecycleBus.on('bus.handler.error', (detail) => {
            lifecycleCalls.push({ event: 'bus.handler.error', detail });
        });

        const bus = new EventBus<TestEvents>({ lifecycleBus });
        bus.on('data.synced', () => {
            throw new Error('boom');
        });
        await bus.emit('data.synced', 1);

        expect(lifecycleCalls.length).toBe(1);
        const call = lifecycleCalls[0] as { event: string; detail: unknown };
        expect(call.event).toBe('bus.handler.error');
        const detail = call.detail as { event: string; mode: string; error: string };
        expect(detail.event).toBe('data.synced');
        expect(detail.mode).toBe('sync');
        expect(detail.error).toBe('boom');
    });

    test('emit enqueues async handlers to jobQueue and publishes lifecycle event', async () => {
        const enqueued: string[] = [];
        const mockJobQueue: JobQueue = {
            async enqueue(type: string, _payload: unknown) {
                enqueued.push(type);
                return 'job-1';
            },
            async enqueueBatch(_jobs: Array<{ type: string; payload: unknown }>) {
                return [];
            },
        };

        const lifecycleCalls: Array<{ event: string; detail: unknown }> = [];
        const lifecycleBus = new EventBus<BusLifecycleEvents>();
        lifecycleBus.on('bus.handler.async.enqueued', (detail) => {
            lifecycleCalls.push({ event: 'bus.handler.async.enqueued', detail });
        });

        const bus = new EventBus<TestEvents>({ jobQueue: mockJobQueue, lifecycleBus });
        bus.on('user.created', () => {}, { async: true });
        bus.on('user.created', () => {}, { async: true });
        await bus.emit('user.created', 'u1', 'Alice');

        expect(enqueued).toEqual(['user.created']);
        expect(lifecycleCalls.length).toBe(1);
        const call = lifecycleCalls[0] as { event: string; detail: unknown };
        expect(call.event).toBe('bus.handler.async.enqueued');
        const detail = call.detail as { event: string; jobId: string; handlerCount: number };
        expect(detail.jobId).toBe('job-1');
        expect(detail.handlerCount).toBe(2);
    });

    test('emit warns when async handlers registered but no JobQueue', async () => {
        const bus = new EventBus<TestEvents>();
        bus.on('user.created', () => {}, { async: true });
        // Should not throw — just logs a warning
        await bus.emit('user.created', 'u1', 'Alice');
    });

    test('emit handles jobQueue.enqueue failure gracefully', async () => {
        const lifecycleCalls: Array<{ event: string; detail: unknown }> = [];
        const lifecycleBus = new EventBus<BusLifecycleEvents>();
        lifecycleBus.on('bus.handler.error', (detail) => {
            lifecycleCalls.push({ event: 'bus.handler.error', detail });
        });

        const mockJobQueue: JobQueue = {
            async enqueue() {
                throw new Error('queue down');
            },
            async enqueueBatch() {
                return [];
            },
        };

        const bus = new EventBus<TestEvents>({ jobQueue: mockJobQueue, lifecycleBus });
        bus.on('user.created', () => {}, { async: true });
        await bus.emit('user.created', 'u1', 'Alice');

        expect(lifecycleCalls.length).toBe(1);
        const call = lifecycleCalls[0] as { event: string; detail: unknown };
        const detail = call.detail as { mode: string; error: string };
        expect(detail.mode).toBe('async');
        expect(detail.error).toBe('queue down');
    });

    test('listenerCount with sync mode only counts sync handlers', () => {
        const bus = new EventBus<TestEvents>();
        bus.on('user.created', () => {});
        bus.on('user.created', () => {}, { async: true });

        expect(bus.listenerCount('user.created', 'sync')).toBe(1);
        expect(bus.listenerCount('user.created', 'async')).toBe(1);
        expect(bus.listenerCount('user.created')).toBe(2);
    });
});
