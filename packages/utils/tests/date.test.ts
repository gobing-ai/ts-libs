import { describe, expect, test } from 'bun:test';

import { fromMs, nowMs, toMs } from '../src/date';

describe('nowMs', () => {
    test('returns a current positive epoch millisecond value', () => {
        const before = Date.now();
        const result = nowMs();
        const after = Date.now();

        expect(result).toBeGreaterThan(0);
        expect(result).toBeGreaterThanOrEqual(before);
        expect(result).toBeLessThanOrEqual(after);
    });
});

describe('toMs', () => {
    test('converts Date to epoch milliseconds', () => {
        const date = new Date('2024-06-15T12:00:00Z');

        expect(toMs(date)).toBe(date.getTime());
    });

    test('floors numeric timestamps', () => {
        expect(toMs(1_718_452_800_000.7)).toBe(1_718_452_800_000);
    });

    test('converts ISO strings to epoch milliseconds', () => {
        expect(toMs('2024-06-15T12:00:00Z')).toBe(new Date('2024-06-15T12:00:00Z').getTime());
    });

    test('returns null for invalid or nullish input', () => {
        expect(toMs('not-a-date')).toBeNull();
        expect(toMs(null)).toBeNull();
        expect(toMs(undefined)).toBeNull();
    });
});

describe('fromMs', () => {
    test('converts epoch milliseconds to Date', () => {
        const date = fromMs(1_718_452_800_000);

        expect(date).toBeInstanceOf(Date);
        expect(date?.getTime()).toBe(1_718_452_800_000);
    });

    test('returns null for invalid or nullish input', () => {
        expect(fromMs(null)).toBeNull();
        expect(fromMs(undefined)).toBeNull();
        expect(fromMs(Number.NaN)).toBeNull();
    });
});
