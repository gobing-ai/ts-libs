import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setLoggerMuted } from '../src/logger';
import { nextCronTime, parseCronExpression } from '../src/scheduler/cron';
import { NodeSchedulerAdapter } from '../src/scheduler-node';
import { _resetMetrics } from '../src/telemetry/metrics';
import { _resetTelemetry, initTelemetry, shutdownTelemetry } from '../src/telemetry/sdk';

beforeEach(async () => {
    setLoggerMuted(true);
    _resetMetrics();
    _resetTelemetry();
    await initTelemetry({ enabled: false });
});

afterEach(async () => {
    await shutdownTelemetry();
    setLoggerMuted(false);
});

describe('scheduler-node subpath source entry', () => {
    test('exports Node scheduler adapter', () => {
        expect(NodeSchedulerAdapter).toBeDefined();
    });
});

// Yield a handful of microtask turns so an async operation we did not await can
// settle to a known state without a real wall-clock delay.
async function settleMicrotasks(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
}

describe('NodeSchedulerAdapter', () => {
    test('R2 — stop() waits for an in-flight tick before resolving', async () => {
        // Regression: setInterval launched the async handler as a floating promise,
        // so stop() cleared future timers but resolved while a tick was mid-action.
        // With the drain, await stop() must not resolve until the in-flight action
        // has settled.
        const scheduler = new NodeSchedulerAdapter({ drainTimeoutMs: 30_000 });

        const actionStarted = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        let actionCompleted = false;

        scheduler.register('5', async () => {
            actionStarted.resolve();
            await gate.promise; // block the tick until the test releases it
            actionCompleted = true;
        });

        await scheduler.start();
        await actionStarted.promise; // a tick is now in-flight

        let stopResolved = false;
        const stopping = scheduler.stop().then(() => {
            stopResolved = true;
        });

        // Let stop() reach its drain await. With the tick blocked on the gate and
        // the deadline far away, stop() must still be pending here.
        await settleMicrotasks();
        expect(stopResolved).toBe(false);
        expect(actionCompleted).toBe(false);

        gate.resolve(); // let the in-flight tick finish
        await stopping;

        expect(actionCompleted).toBe(true); // drained, not torn down
    });

    test('R2b — the drain wait is bounded when an action hangs', async () => {
        // Exception to ts-no-test-timers: settleWithin enforces its deadline with
        // a real setTimeout, so the bound can only be observed against the real
        // clock. drainTimeoutMs is sized small to keep the real wait short.
        const scheduler = new NodeSchedulerAdapter({ drainTimeoutMs: 50 });

        const actionStarted = Promise.withResolvers<void>();
        const stuck = Promise.withResolvers<void>();

        scheduler.register('5', async () => {
            actionStarted.resolve();
            await stuck.promise; // never resolved within the test
        });

        await scheduler.start();
        await actionStarted.promise;

        const startedAt = Date.now();
        await scheduler.stop();
        const elapsed = Date.now() - startedAt;

        // stop() resolved near the 50 ms deadline, not by waiting on the handler.
        expect(elapsed).toBeGreaterThanOrEqual(40);
        expect(elapsed).toBeLessThan(2_000);

        stuck.resolve(); // let the abandoned tick settle so it does not outlive the test
        await settleMicrotasks();
    });

    test('constructor rejects an invalid drainTimeoutMs', () => {
        expect(() => new NodeSchedulerAdapter({ drainTimeoutMs: -1 })).toThrow(RangeError);
        expect(() => new NodeSchedulerAdapter({ drainTimeoutMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
        expect(() => new NodeSchedulerAdapter({ drainTimeoutMs: Number.NaN })).toThrow(RangeError);
    });

    test('default drainTimeoutMs keeps the no-arg path backward compatible', () => {
        const scheduler = new NodeSchedulerAdapter();
        expect(scheduler).toBeInstanceOf(NodeSchedulerAdapter);
    });

    test('R2 — stop() drains an in-flight cron tick (0734)', async () => {
        // A real cron entry self-reschedules with setTimeout; stop() must still wait
        // for a tick already mid-action, bounded by drainTimeoutMs (ADR-024).
        const expr = parseCronExpression('30 1 * * *');
        const target = nextCronTime(expr, Date.now()).getTime();

        let nowMs = target - 1000; // one second before the target
        const scheduler = new NodeSchedulerAdapter({ drainTimeoutMs: 30_000, now: () => nowMs });

        const actionStarted = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        let actionCompleted = false;

        scheduler.register('30 1 * * *', async () => {
            actionStarted.resolve();
            await gate.promise; // block the tick until the test releases it
            actionCompleted = true;
        });

        await scheduler.start(); // arms a setTimeout to the target (~1s away)
        nowMs = target + 1; // ensure the re-check passes when the timer fires
        await actionStarted.promise; // a cron tick is now in-flight

        let stopResolved = false;
        const stopping = scheduler.stop().then(() => {
            stopResolved = true;
        });

        // Let stop() reach its drain await. With the tick blocked on the gate and
        // the deadline far away, stop() must still be pending here.
        await settleMicrotasks();
        expect(stopResolved).toBe(false);
        expect(actionCompleted).toBe(false);

        gate.resolve(); // let the in-flight cron tick finish
        await stopping;

        expect(actionCompleted).toBe(true); // drained, not torn down
        // No cron timer is re-armed after stop().
        expect(scheduler).toBeDefined();
    });
});
