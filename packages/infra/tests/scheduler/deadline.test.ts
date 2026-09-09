import { describe, expect, test } from 'bun:test';
import { setLoggerMuted } from '../../src/logger';
import { NodeSchedulerAdapter } from '../../src/scheduler/node';

/**
 * Scheduler execution-deadline tests (A21): ticks share the same nullable
 * execution policy and context as queue handlers; expiry requests
 * cancellation without crashing the adapter; omitted policy stays unlimited.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('NodeSchedulerAdapter execution deadlines', () => {
    test('rejects invalid default and per-entry timeoutMs at configuration time', () => {
        expect(() => new NodeSchedulerAdapter({ timeoutMs: 0 })).toThrow(RangeError);
        expect(() => new NodeSchedulerAdapter({ timeoutMs: -5 })).toThrow(RangeError);
        expect(() => new NodeSchedulerAdapter({ timeoutMs: 1.5 })).toThrow(RangeError);
        expect(() => new NodeSchedulerAdapter({ timeoutMs: null })).not.toThrow();
        expect(() => new NodeSchedulerAdapter({ timeoutMs: 1_000 })).not.toThrow();

        const adapter = new NodeSchedulerAdapter();
        expect(() => adapter.register('20', async () => {}, { timeoutMs: 0 })).toThrow(RangeError);
    });

    test('finite deadline aborts the tick through the shared context', async () => {
        setLoggerMuted(true);
        const adapter = new NodeSchedulerAdapter();
        let sawContext: { deadlineMs: number | null; aborted: boolean } | undefined;
        let invocations = 0;

        adapter.register(
            '20',
            async (ctx) => {
                if (invocations++ > 0) return; // later ticks: already asserted
                sawContext = { deadlineMs: ctx.deadlineMs, aborted: ctx.signal.aborted };
                await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
            },
            { timeoutMs: 40 },
        );

        await adapter.start();
        await sleep(120);
        await adapter.stop();

        expect(sawContext).toEqual({ deadlineMs: 40, aborted: false });
        expect(invocations).toBeGreaterThan(0);
    });

    test('omitted policy keeps unlimited tick execution', async () => {
        setLoggerMuted(true);
        const adapter = new NodeSchedulerAdapter();
        let completed = false;

        adapter.register('20', async (ctx) => {
            expect(ctx.deadlineMs).toBeNull();
            await sleep(80); // would have exceeded any accidental default
            if (!ctx.signal.aborted) completed = true;
        });

        await adapter.start();
        await sleep(150);
        await adapter.stop();

        expect(completed).toBeTrue();
    });
});
