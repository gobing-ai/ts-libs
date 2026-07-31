import { describe, expect, test } from 'bun:test';
import { EventBus } from '../src/event-bus/event-bus';
import type { InfraEvents } from '../src/events';

/**
 * events.ts is type-only, so these tests verify the maps are usable as an
 * `EventBus` event map and that each infra event carries the expected payload
 * shape — the contract observers (F1) and the scheduler wrapper (F3) rely on.
 */
describe('infra events', () => {
    test('InfraEvents composes into a typed EventBus', async () => {
        const bus = new EventBus<InfraEvents>();
        const seen: string[] = [];

        bus.on('queue.job.failed', (d) => seen.push(`failed:${d.jobId}:${d.attempt}`));
        bus.on('scheduler.job.executed', (d) => seen.push(`sched:${d.name}:${d.durationMs}`));
        bus.on('db.connected', () => seen.push('db:connected'));
        bus.on('api.request.error', (d) => seen.push(`api:${d.method}:${d.status ?? 0}`));

        await bus.emit('queue.job.failed', { jobId: 'j1', type: 'ORDER', error: 'boom', attempt: 3, maxRetries: 3 });
        await bus.emit('scheduler.job.executed', { name: 'nightly', durationMs: 42 });
        await bus.emit('db.connected');
        await bus.emit('api.request.error', { url: '/x', method: 'GET', status: 500, error: 'fail' });

        expect(seen).toEqual(['failed:j1:3', 'sched:nightly:42', 'db:connected', 'api:GET:500']);
    });

    test('queue.stats carries the QueueStats shape', async () => {
        const bus = new EventBus<InfraEvents>();
        let captured: { pending: number } | undefined;
        bus.on('queue.stats', (s) => {
            captured = s;
        });
        await bus.emit('queue.stats', { pending: 2, processing: 1, completed: 10, failed: 0 });
        expect(captured?.pending).toBe(2);
    });

    test('consumer lifecycle events carry config and drain detail (R5)', async () => {
        const bus = new EventBus<InfraEvents>();
        let started: { pollInterval: unknown } | undefined;
        let stopped: { drained: unknown } | undefined;
        bus.on('queue.consumer.started', (d) => {
            started = d;
        });
        bus.on('queue.consumer.stopped', (d) => {
            stopped = d;
        });

        await bus.emit('queue.consumer.started', {
            startedAt: Date.now(),
            pollInterval: 1000,
            batchSize: 10,
            maxConcurrency: 5,
            visibilityTimeout: 30_000,
        });
        await bus.emit('queue.consumer.stopped', {
            stoppedAt: Date.now(),
            drainTimeoutMs: 30_000,
            inFlightAtStop: 0,
            drained: true,
        });

        expect(started).toBeDefined();
        expect(started?.pollInterval).toBe(1000);
        expect(stopped).toBeDefined();
        expect(stopped?.drained).toBe(true);
    });
});
