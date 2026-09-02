import { describe, expect, test } from 'bun:test';
import { nextCronTime, parseCronExpression } from '../../src/scheduler/cron';
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

    test('R1 — legacy cadences and real five-field cron are both accepted (0734)', async () => {
        const s = new NodeSchedulerAdapter();
        // Legacy interval forms stay accepted.
        for (const expr of ['60000', '* * * * *', '*/5 * * * *']) {
            expect(() => s.register(expr, async () => {})).not.toThrow();
        }
        // Real cron forms are now accepted too (0734 supersedes the 0060 F7 rejections).
        for (const expr of ['0 3 * * *', '* 3 * * *', '30 8 1,15 * 1-5', '*/5 3 * * *']) {
            expect(() => s.register(expr, async () => {})).not.toThrow();
        }
    });

    test('R1 — invalid cron throws RangeError at register time (0734)', async () => {
        const s = new NodeSchedulerAdapter();
        const invalid = [
            '0 25 * * *', // hour out of range
            '1-0 * * * *', // descending range
            '*/0 * * * *', // zero step
            '0 3 * * MON', // names/macros unsupported
            '0 60 * * *', // minute out of range
            '0 3 0 * *', // day-of-month out of range (1-31)
            '0 3 * 13 *', // month out of range
            '0 3 * * 8', // day-of-week out of range (0-7)
            '0 3 * * * *', // six fields
            '0 3 *', // three fields
            '1,,2 * * * *', // empty list member
            '0 3 * * 1-0', // descending range in dow
            '@daily', // macro
            '0 3 L * *', // L unsupported
            '0 3 * * ?', // ? unsupported
        ];
        for (const expr of invalid) {
            expect(() => s.register(expr, async () => {})).toThrow(RangeError);
        }
        // No timer is created for the rejected entries.
        await expect(s.start()).resolves.toBeUndefined();
    });

    test('R1 — standard cron day-of-month/day-of-week OR semantics (0734)', () => {
        const expr = parseCronExpression('30 8 1,15 * 1-5');

        // 2026-02-01 is a Sunday (day=0): the day-of-month rule (1st) must still fire it.
        const fromJan31 = new Date(2026, 0, 31, 23, 0, 0).getTime();
        const sundayFire = nextCronTime(expr, fromJan31);
        expect(sundayFire.getFullYear()).toBe(2026);
        expect(sundayFire.getMonth()).toBe(1); // February
        expect(sundayFire.getDate()).toBe(1);
        expect(sundayFire.getHours()).toBe(8);
        expect(sundayFire.getMinutes()).toBe(30);
        expect(sundayFire.getDay()).toBe(0); // Sunday — matched via the day-of-month OR

        // 2026-02-02 is a Monday: the day-of-week rule must fire it even though it is
        // neither the 1st nor the 15th.
        const fromFeb1 = new Date(2026, 1, 1, 23, 59, 0).getTime();
        const mondayFire = nextCronTime(expr, fromFeb1);
        expect(mondayFire.getDate()).toBe(2);
        expect(mondayFire.getDay()).toBe(1); // Monday
    });

    test('R1 — single-field and list/range grammar (0734)', () => {
        const s = new NodeSchedulerAdapter();
        for (const expr of [
            '5,10,15 * * * *',
            '5-10 * * * *',
            '30 8 1-5 * *',
            '0 0 1 1 0', // Jan 1, Sunday (0 = Sunday)
            '30 1 29 2 7', // 7 aliases to Sunday
        ]) {
            expect(() => s.register(expr, async () => {})).not.toThrow();
        }
    });

    test('R2 — nextCronTime is strictly after now and uses local wall-clock fields (0734)', () => {
        const expr = parseCronExpression('30 1 * * *');
        // Just before 01:30 on 2026-01-01 (local): the next match is exactly 01:30.
        const before = new Date(2026, 0, 1, 1, 29, 0).getTime();
        const next = nextCronTime(expr, before);
        expect(next.getHours()).toBe(1);
        expect(next.getMinutes()).toBe(30);
        expect(next.getDate()).toBe(1);

        // Strictly-after: from exactly 01:30, the next match is the following day.
        const at130 = new Date(2026, 0, 1, 1, 30, 0).getTime();
        const after = nextCronTime(expr, at130);
        expect(after.getDate()).toBe(2);
        expect(after.getHours()).toBe(1);
        expect(after.getMinutes()).toBe(30);
    });

    test('R2 — DST fall-back day fires both distinct 01:30 instants once each (0734)', () => {
        const prevTz = process.env.TZ;
        process.env.TZ = 'America/Los_Angeles';
        try {
            const expr = parseCronExpression('30 1 * * *');
            // 2026-11-01 01:30 PDT = 08:30Z; 01:30 PST = 09:30Z. Both are wall-clock 01:30.
            const first = Date.UTC(2026, 10, 1, 8, 30, 0);
            const second = Date.UTC(2026, 10, 1, 9, 30, 0);

            const start = Date.UTC(2026, 10, 1, 7, 30, 0); // 00:30 PDT
            expect(nextCronTime(expr, start).getTime()).toBe(first);
            expect(nextCronTime(expr, first).getTime()).toBe(second);
            // Strictly-after: from the second instant, the next match is the next day.
            expect(nextCronTime(expr, second).getTime()).not.toBe(second);
        } finally {
            process.env.TZ = prevTz;
        }
    });

    test('R1 — unsatisfiable expression fails at registration (0734)', () => {
        const s = new NodeSchedulerAdapter();
        // '30 1 31 2 *' requires Feb 31, which never exists; the 8-year scan bound
        // must fail registration loud rather than never fire.
        expect(() => s.register('30 1 31 2 *', async () => {})).toThrow(RangeError);
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
