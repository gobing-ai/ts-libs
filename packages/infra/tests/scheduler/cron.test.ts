import { describe, expect, test } from 'bun:test';
import { matchesCron, nextCronTime, parseCronExpression } from '../../src/scheduler/cron';

describe('cron grammar (internal module, task 0734)', () => {
    test('parseCronExpression accepts the documented grammar', () => {
        for (const expr of [
            '0 3 * * *',
            '* 3 * * *',
            '*/5 * * * *',
            '30 8 1,15 * 1-5',
            '5,10,15 * * * *',
            '5-10 * * * *',
            '30 1 29 2 7', // 7 aliases to Sunday
            '0 0 1 1 0',
        ]) {
            expect(() => parseCronExpression(expr)).not.toThrow();
        }
    });

    test('parseCronExpression rejects invalid grammar with RangeError', () => {
        for (const expr of [
            '0 25 * * *', // hour out of range
            '1-0 * * * *', // descending range
            '*/0 * * * *', // zero step
            '0 3 * * MON', // names unsupported
            '0 3 * * * *', // six fields
            '0 3 *', // three fields
            '1,,2 * * * *', // empty list member
            '@daily', // macro
            '0 3 L * *', // L unsupported
        ]) {
            expect(() => parseCronExpression(expr)).toThrow(RangeError);
        }
    });

    test('day-of-week 7 normalizes to 0 (Sunday)', () => {
        const seven = parseCronExpression('30 1 * * 7');
        const zero = parseCronExpression('30 1 * * 0');
        expect(seven.dayOfWeek.wildcard).toBe(false);
        expect(seven.dayOfWeek.values.has(0)).toBe(true);
        expect(seven.dayOfWeek.values.has(7)).toBe(false);
        // A Sunday instant matches both.
        const sunday = new Date(2026, 1, 1, 1, 30, 0); // 2026-02-01 is a Sunday
        expect(matchesCron(sunday, seven)).toBe(true);
        expect(matchesCron(sunday, zero)).toBe(true);
    });

    test('matchesCron applies standard day OR semantics', () => {
        // '30 8 1,15 * 1-5': restricted both — either day rule may match.
        const expr = parseCronExpression('30 8 1,15 * 1-5');

        // Sunday Feb 1 2026 (day 0, weekday no): matched via day-of-month.
        expect(matchesCron(new Date(2026, 1, 1, 8, 30, 0), expr)).toBe(true);
        // Monday Feb 2 2026 (weekday yes, day neither 1 nor 15): matched via day-of-week.
        expect(matchesCron(new Date(2026, 1, 2, 8, 30, 0), expr)).toBe(true);
        // Saturday Feb 14 2026 (weekday no, day neither): not matched.
        expect(matchesCron(new Date(2026, 1, 14, 8, 30, 0), expr)).toBe(false);
    });

    test('nextCronTime scans forward to the next matching local minute', () => {
        const expr = parseCronExpression('*/10 * * * *');
        const start = new Date(2026, 0, 1, 0, 3, 0).getTime();
        const next = nextCronTime(expr, start);
        expect(next.getMinutes()).toBe(10);
        expect(next.getHours()).toBe(0);
        expect(next.getTime()).toBeGreaterThan(start);
    });

    test('nextCronTime never returns the current instant (strictly after)', () => {
        const expr = parseCronExpression('30 1 * * *');
        const at = new Date(2026, 0, 1, 1, 30, 0).getTime();
        const next = nextCronTime(expr, at);
        expect(next.getTime()).toBeGreaterThan(at);
    });
});
