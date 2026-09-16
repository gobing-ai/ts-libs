import { describe, expect, test } from 'bun:test';
import { EventBus } from '../../src/event-bus/event-bus';
import type { SchedulerEvents } from '../../src/events';
import { unlimitedExecutionContext } from '../../src/execution-policy';
import { wrapScheduledHandler } from '../../src/scheduler/wrap-handler';

describe('wrapScheduledHandler', () => {
    test('runs the action and emits scheduler.job.executed with duration', async () => {
        const bus = new EventBus<SchedulerEvents>();
        const events: Array<{ name: string; action?: string; durationMs: number; error?: string }> = [];
        bus.on('scheduler.job.executed', (d) => events.push(d));

        let ran = false;
        const wrapped = wrapScheduledHandler(
            'nightly',
            async () => {
                ran = true;
            },
            bus,
            'refresh history daily',
        );

        await wrapped(unlimitedExecutionContext());

        expect(ran).toBe(true);
        expect(events).toHaveLength(1);
        expect(events[0]?.name).toBe('nightly');
        expect(events[0]?.action).toBe('refresh history daily');
        expect(typeof events[0]?.durationMs).toBe('number');
        expect(events[0]?.error).toBeUndefined();
    });

    test('rethrows action errors and emits the event with the error message', async () => {
        const bus = new EventBus<SchedulerEvents>();
        let captured: { name: string; action?: string; error?: string } | undefined;
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

        await expect(wrapped(unlimitedExecutionContext())).rejects.toThrow('kaboom');
        expect(captured?.name).toBe('boom');
        expect(captured?.error).toBe('kaboom');
        // No label passed — the optional action key must be absent, not null.
        expect(captured?.action).toBeUndefined();
    });

    test('works without a system bus (tracing only)', async () => {
        let ran = false;
        const wrapped = wrapScheduledHandler('no-bus', async () => {
            ran = true;
        });
        await expect(wrapped(unlimitedExecutionContext())).resolves.toBeUndefined();
        expect(ran).toBe(true);
    });
});
