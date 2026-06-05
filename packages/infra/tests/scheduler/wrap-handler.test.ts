import { describe, expect, test } from 'bun:test';
import { EventBus } from '../../src/event-bus/event-bus';
import type { SchedulerEvents } from '../../src/events';
import { wrapScheduledHandler } from '../../src/scheduler/wrap-handler';

describe('wrapScheduledHandler', () => {
    test('runs the action and emits scheduler.job.executed with duration', async () => {
        const bus = new EventBus<SchedulerEvents>();
        const events: Array<{ name: string; durationMs: number; error?: string }> = [];
        bus.on('scheduler.job.executed', (d) => events.push(d));

        let ran = false;
        const wrapped = wrapScheduledHandler(
            'nightly',
            async () => {
                ran = true;
            },
            bus,
        );

        await wrapped();

        expect(ran).toBe(true);
        expect(events).toHaveLength(1);
        expect(events[0]?.name).toBe('nightly');
        expect(typeof events[0]?.durationMs).toBe('number');
        expect(events[0]?.error).toBeUndefined();
    });

    test('rethrows action errors and emits the event with the error message', async () => {
        const bus = new EventBus<SchedulerEvents>();
        let captured: { name: string; error?: string } | undefined;
        bus.on('scheduler.job.executed', (d) => {
            captured = d;
        });

        const wrapped = wrapScheduledHandler(
            'boom',
            async () => {
                throw new Error('kaboom');
            },
            bus,
        );

        await expect(wrapped()).rejects.toThrow('kaboom');
        expect(captured?.name).toBe('boom');
        expect(captured?.error).toBe('kaboom');
    });

    test('works without a system bus (tracing only)', async () => {
        let ran = false;
        const wrapped = wrapScheduledHandler('no-bus', async () => {
            ran = true;
        });
        await expect(wrapped()).resolves.toBeUndefined();
        expect(ran).toBe(true);
    });
});
