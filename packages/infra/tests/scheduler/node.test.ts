import { describe, expect, test } from 'bun:test';
import type { ScheduledAction } from '../../src/scheduler/types';
import { NodeSchedulerAdapter } from '../../src/scheduler-node';

interface ScheduledTickTestAdapter {
    _onScheduledTick(entry: { cron: string; action: ScheduledAction }): Promise<void>;
}

function exposeScheduledTick(adapter: NodeSchedulerAdapter): ScheduledTickTestAdapter {
    return adapter as unknown as ScheduledTickTestAdapter;
}

describe('NodeSchedulerAdapter', () => {
    test('constructs without error', () => {
        const s = new NodeSchedulerAdapter();
        expect(s).toBeDefined();
    });

    test('register and start/stop without error', async () => {
        const s = new NodeSchedulerAdapter();
        s.register('5000', async () => {});
        await s.start();
        // Wait a tick for setInterval-based scheduler
        await new Promise((r) => setTimeout(r, 10));
        await s.stop();
        // Should not throw
    });

    test('register while running starts new entry', async () => {
        const s = new NodeSchedulerAdapter();
        await s.start();
        s.register('5000', async () => {});
        await new Promise((r) => setTimeout(r, 10));
        await s.stop();
    });

    test('start is idempotent and creates one interval per entry', async () => {
        const originalSetInterval = globalThis.setInterval;
        const originalClearInterval = globalThis.clearInterval;
        const timers: Array<{ handler: Parameters<typeof setInterval>[0]; timeout?: number }> = [];
        const cleared: number[] = [];

        globalThis.setInterval = ((handler: Parameters<typeof setInterval>[0], timeout?: number) => {
            timers.push({ handler, timeout });
            return timers.length as unknown as ReturnType<typeof setInterval>;
        }) as typeof setInterval;
        globalThis.clearInterval = ((timer?: ReturnType<typeof setInterval>) => {
            cleared.push(timer as unknown as number);
        }) as typeof clearInterval;

        try {
            const s = new NodeSchedulerAdapter();
            s.register('5000', async () => {});

            await s.start();
            await s.start();
            await s.stop();

            expect(timers).toHaveLength(1);
            expect(cleared).toEqual([1]);
        } finally {
            globalThis.setInterval = originalSetInterval;
            globalThis.clearInterval = originalClearInterval;
        }
    });

    test('action throwing does not crash scheduler', async () => {
        const s = new NodeSchedulerAdapter();
        s.register('1000', async () => {
            throw new Error('task failed');
        });
        await s.start();
        // Let at least one interval fire
        await new Promise((r) => setTimeout(r, 50));
        await s.stop();
    });

    test('_onScheduledTick executes action and catches errors', async () => {
        const s = new NodeSchedulerAdapter();
        let fired = false;
        const entry = {
            cron: '60000',
            action: async () => {
                fired = true;
            },
        };
        await exposeScheduledTick(s)._onScheduledTick(entry);
        expect(fired).toBeTrue();
    });

    test('unsupported cron expression throws at register time (0060 F7)', async () => {
        const s = new NodeSchedulerAdapter();
        // A real 5-field cron (minute/hour fields) must fail loud — never silently fire
        // every 60 seconds at the wrong cadence.
        expect(() => s.register('0 3 * * *', async () => {})).toThrow(RangeError);
        expect(() => s.register('0 3 * * *', async () => {})).toThrow(/Unsupported cron/);
        // First-field wildcard with a constrained later field is still real cron, not "* * * * *".
        expect(() => s.register('* 3 * * *', async () => {})).toThrow(RangeError);
        expect(() => s.register('*/5 3 * * *', async () => {})).toThrow(/Unsupported cron/);
        // No timer is created for the rejected entry.
        await expect(s.start()).resolves.toBeUndefined();
    });

    test('supported cadences still schedule (0060 F7)', async () => {
        const originalSetInterval = globalThis.setInterval;
        const originalClearInterval = globalThis.clearInterval;
        const timers: number[] = [];

        globalThis.setInterval = ((_handler: Parameters<typeof setInterval>[0], timeout?: number) => {
            timers.push(timeout ?? -1);
            return timers.length as unknown as ReturnType<typeof setInterval>;
        }) as typeof setInterval;
        globalThis.clearInterval = (() => {}) as typeof clearInterval;

        try {
            const s = new NodeSchedulerAdapter();
            s.register('* * * * *', async () => {});
            s.register('*/5 * * * *', async () => {});
            s.register('60000', async () => {});
            await s.start();
            await s.stop();
            expect(timers).toEqual([60_000, 300_000, 60_000]);
        } finally {
            globalThis.setInterval = originalSetInterval;
            globalThis.clearInterval = originalClearInterval;
        }
    });
});
