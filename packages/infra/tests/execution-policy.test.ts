import { describe, expect, test } from 'bun:test';
import { type ExecutionContext, resolveExecutionTimeoutMs, runWithExecutionDeadline } from '../src/execution-policy';

/**
 * Shared execution deadline policy tests (A21): one nullable policy, one
 * clock per execution, cancellation requested on expiry with settlement
 * awaited — never a second timer racing the deadline.
 */

describe('resolveExecutionTimeoutMs', () => {
    test('omitted inherits the parent scope', () => {
        expect(resolveExecutionTimeoutMs('job', undefined, 5_000)).toBe(5_000);
        expect(resolveExecutionTimeoutMs('job', undefined, null)).toBeNull();
        expect(resolveExecutionTimeoutMs('job', undefined, undefined)).toBeNull();
    });

    test('explicit null disables this scope deadline even over a finite parent', () => {
        expect(resolveExecutionTimeoutMs('job', null, 5_000)).toBeNull();
    });

    test('explicit finite value wins over inheritance', () => {
        expect(resolveExecutionTimeoutMs('job', 1_000, 5_000)).toBe(1_000);
    });

    test('invalid explicit values are rejected before work', () => {
        for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '100', true]) {
            expect(() => resolveExecutionTimeoutMs('job', invalid as unknown as number)).toThrow(RangeError);
        }
    });
});

describe('runWithExecutionDeadline', () => {
    test('completes without arming a timer for unlimited policy', async () => {
        let observed: ExecutionContext | undefined;
        const result = await runWithExecutionDeadline(
            async (ctx) => {
                observed = ctx;
                await new Promise((resolve) => setTimeout(resolve, 30));
            },
            { timeoutMs: null },
        );

        expect(result.outcome).toBe('completed');
        expect(result.timedOut).toBeFalse();
        expect(observed?.deadlineMs).toBeNull();
        expect(observed?.signal.aborted).toBeFalse();
        expect(observed?.cancellationReason).toBeUndefined();
    });

    test('deadline expiry aborts the context, awaits settlement, and reports timeout', async () => {
        let sawAbort = false;
        let settledAfterAbort = false;
        const result = await runWithExecutionDeadline(
            async (ctx) => {
                await new Promise((resolve) => {
                    ctx.signal.addEventListener('abort', () => {
                        sawAbort = true;
                        setTimeout(resolve, 20);
                    });
                });
                settledAfterAbort = true;
            },
            { timeoutMs: 30 },
        );

        expect(sawAbort).toBeTrue();
        expect(settledAfterAbort).toBeTrue();
        expect(result.outcome).toBe('timeout');
        expect(result.timedOut).toBeTrue();
        expect(result.elapsedMs).toBeGreaterThanOrEqual(30);
    });

    test('an uncooperative handler is not reported as successfully cancelled', async () => {
        const result = await runWithExecutionDeadline(
            async () => {
                // Ignores the signal entirely; the executor must still await it.
                await new Promise((resolve) => setTimeout(resolve, 60));
            },
            { timeoutMs: 20 },
        );

        expect(result.timedOut).toBeTrue();
        expect(result.outcome).toBe('timeout');
        expect(result.elapsedMs).toBeGreaterThanOrEqual(50);
    });

    test('external cancellation composes into the same controller', async () => {
        const external = new AbortController();
        const running = runWithExecutionDeadline(
            async (ctx) => {
                await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve));
            },
            { timeoutMs: null, signal: external.signal },
        );

        setTimeout(() => external.abort(), 20);
        const result = await running;

        expect(result.outcome).toBe('cancelled');
        expect(result.timedOut).toBeFalse();
    });

    test('handler errors surface as error outcome', async () => {
        const result = await runWithExecutionDeadline(
            async () => {
                throw new Error('boom');
            },
            { timeoutMs: null },
        );

        expect(result.outcome).toBe('error');
        expect((result.error as Error).message).toBe('boom');
    });
});
