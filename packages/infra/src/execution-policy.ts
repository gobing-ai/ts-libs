/**
 * Shared execution-deadline policy for background work (feature A21).
 *
 * One nullable policy (`number | null`) and one clock per execution: a finite
 * deadline arms a single timer that requests cancellation through an
 * `AbortController`; the executor always awaits the handler's settlement, even
 * when the handler ignores the abort signal. Both the queue consumer and the
 * Node scheduler run their work through this seam so deadline, cancellation,
 * and timing semantics stay identical across surfaces.
 *
 * Resolution is first-match-wins down the scope chain: an explicit job value
 * (including explicit `null` = unlimited) beats the consumer default; absence
 * (`undefined`) inherits; an absent inherited value is unlimited. A scope
 * never *negates* an inherited finite deadline by being omitted — only an
 * explicit `null` opts out.
 */

/** Execution deadline policy: positive integer milliseconds, or `null` = unlimited. */
export type ExecutionDeadlineMs = number | null;

/** Cancellation context handed to job and scheduler handlers. */
export interface ExecutionContext {
    /** Fires when the deadline expires or the caller's signal cancels first. */
    readonly signal: AbortSignal;
    /** The resolved policy for this execution; `null` means unlimited. */
    readonly deadlineMs: ExecutionDeadlineMs;
    /**
     * Why cancellation was requested: `'timeout'` when the execution deadline
     * expired, `'cancelled'` when the caller's signal fired first. `undefined`
     * while the work is not (yet) being cancelled.
     */
    readonly cancellationReason: 'timeout' | 'cancelled' | undefined;
}

/** Outcome of an execution run through {@link runWithExecutionDeadline}. */
export interface ExecutionOutcome {
    /** `'timeout'` and `'cancelled'` still mean the handler settled (or was awaited to settlement). */
    outcome: 'completed' | 'timeout' | 'cancelled' | 'error';
    /** The handler's error when `outcome === 'error'`. */
    error?: unknown;
    elapsedMs: number;
    /** True when the deadline expired, even if the handler ignored the abort and finished late. */
    timedOut: boolean;
}

/** Options for {@link runWithExecutionDeadline}. */
export interface ExecutionDeadlineOptions {
    /** Resolved deadline for this run; `undefined` is treated as unlimited. */
    timeoutMs?: number | null;
    /** Caller-controlled cancellation composed into the same controller. */
    signal?: AbortSignal;
}

/**
 * Resolve the leaf execution policy for one scope.
 *
 * `value === undefined` inherits `inherited` (itself `null` when absent);
 * `value === null` explicitly opts out of this scope's deadline; a positive
 * integer wins outright. Anything else is a configuration error.
 */
export function resolveExecutionTimeoutMs(
    scope: string,
    value: number | null | undefined,
    inherited?: number | null,
): number | null {
    if (value === undefined) {
        return inherited ?? null;
    }
    if (value === null) {
        return null;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throw new RangeError(`${scope} timeoutMs must be a positive integer or null; received ${String(value)}`);
    }
    return value;
}

/**
 * A reusable unlimited context for callers that execute actions without
 * arming a ts-infra deadline — notably the Cloudflare adapter, whose ticks
 * run under the Workers runtime's own limits (A21).
 */
export function unlimitedExecutionContext(): ExecutionContext {
    return {
        signal: new AbortController().signal,
        deadlineMs: null,
        cancellationReason: undefined,
    };
}

/**
 * Run `action` under one shared deadline clock.
 *
 * A finite `timeoutMs` arms exactly one timer that aborts the context's
 * controller (`cancellationReason: 'timeout'`); an aborted caller signal
 * aborts the same controller (`cancellationReason: 'cancelled'`). The handler
 * is always awaited — including after abort, so an uncooperative handler that
 * finishes late is still reported as timed out, never as a successful
 * cancellation — and handler rejections surface as `{ outcome: 'error' }`.
 */
export async function runWithExecutionDeadline<T>(
    action: (context: ExecutionContext) => Promise<T>,
    options: ExecutionDeadlineOptions,
): Promise<ExecutionOutcome & { result?: T }> {
    const deadlineMs = options.timeoutMs ?? null;
    const controller = new AbortController();
    const cancellation: { reason: 'timeout' | 'cancelled' | undefined } = { reason: undefined };

    const context: ExecutionContext = {
        signal: controller.signal,
        deadlineMs,
        get cancellationReason() {
            return cancellation.reason;
        },
    };

    if (options.signal !== undefined) {
        if (options.signal.aborted) {
            cancellation.reason = 'cancelled';
            controller.abort();
        } else {
            const abortFromCaller = (): void => {
                if (cancellation.reason === undefined) cancellation.reason = 'cancelled';
                controller.abort();
            };
            options.signal.addEventListener('abort', abortFromCaller, { once: true });
        }
    }

    const startMs = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (deadlineMs !== null) {
        timer = setTimeout(() => {
            if (cancellation.reason === undefined) cancellation.reason = 'timeout';
            controller.abort();
        }, deadlineMs);
    }

    let result: T | undefined;
    let error: unknown;
    let failed = false;
    try {
        result = await action(context);
    } catch (caught) {
        error = caught;
        failed = true;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }

    const elapsedMs = performance.now() - startMs;
    const timedOut = cancellation.reason === 'timeout';
    if (failed) {
        return { outcome: 'error', error, elapsedMs, timedOut };
    }
    if (timedOut) {
        return {
            outcome: 'timeout',
            error: new Error(`execution deadline (${String(deadlineMs)}ms) expired`),
            elapsedMs,
            timedOut,
        };
    }
    if (cancellation.reason === 'cancelled') {
        return { outcome: 'cancelled', elapsedMs, timedOut };
    }
    return { outcome: 'completed', result, elapsedMs, timedOut };
}
