import { describe, expect, test } from 'bun:test';

import { settleWithin } from '../../src/internals/drain';

describe('settleWithin', () => {
    test('resolves when the awaited promise fulfills before the deadline', async () => {
        // Exception to ts-no-test-timers: settleWithin enforces its bound with a
        // real setTimeout, so the happy path is exercised against the real clock
        // to prove clearTimeout runs on fulfillment (no dangling timer).
        const { promise, resolve } = Promise.withResolvers<void>();
        const deadline = Date.now() + 1_000;

        let settled = false;
        const waiting = settleWithin(promise, deadline).then(() => {
            settled = true;
        });

        resolve();
        await waiting;

        expect(settled).toBe(true);
    });

    test('resolves when the awaited promise rejects before the deadline', async () => {
        const { promise, reject } = Promise.withResolvers<void>();
        const deadline = Date.now() + 1_000;

        // settleWithin never rejects — a rejected input ends the wait the same
        // way a fulfilled one does (so the caller is not surprised by a throw).
        await expect(settleWithin(promise, deadline)).resolves.toBeUndefined();

        reject(new Error('boom')); // settle the input so it does not outlive the test
    });

    test('resolves at the deadline when the awaited promise never settles', async () => {
        // Exception to ts-no-test-timers: the deadline IS the behavior under test.
        const stuck = Promise.withResolvers<void>().promise;
        const deadline = Date.now() + 50;

        const startedAt = Date.now();
        await settleWithin(stuck, deadline);
        const elapsed = Date.now() - startedAt;

        expect(elapsed).toBeGreaterThanOrEqual(40);
        expect(elapsed).toBeLessThan(2_000);
    });

    test('resolves immediately when the deadline has already passed', async () => {
        const stuck = Promise.withResolvers<void>().promise;
        const pastDeadline = Date.now() - 100;

        const startedAt = Date.now();
        await settleWithin(stuck, pastDeadline);
        const elapsed = Date.now() - startedAt;

        expect(elapsed).toBeLessThan(50);
    });
});
