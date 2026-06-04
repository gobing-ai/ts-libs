/**
 * Event bus types — shared constraints for typed pub-sub.
 */

/** Type constraint for event maps — keys are event names, values are listener signatures. */
export type EventMap = Record<string, (...args: never[]) => void>;

/** Options for subscribing to an event, including async dispatch mode. */
export interface SubscribeOptions {
    /** When true, the handler is dispatched through the async handler path. */
    async?: boolean;
}

// ── Lifecycle events ────────────────────────────────────────────────

/** Payload emitted on `bus.emit.done` after synchronous handlers complete. */
export interface EmitDoneDetail {
    event: string;
    syncCount: number;
    asyncCount: number;
    emitDurationMs: number;
    errors: number;
    detail?: unknown;
}

/** Payload emitted on `bus.handler.error` when a handler throws. */
export interface HandlerErrorDetail {
    event: string;
    mode: 'sync' | 'async';
    error: string;
}

/** Payload emitted on `bus.handler.async.enqueued` when async handlers are scheduled. */
export interface AsyncEnqueuedDetail {
    event: string;
    jobId: string;
    handlerCount: number;
}

/** Strongly-typed lifecycle events emitted by the event bus. */
export type BusLifecycleEvents = {
    'bus.emit.done': (detail: EmitDoneDetail) => void;
    'bus.emit.noop': (detail: { event: string }) => void;
    'bus.handler.error': (detail: HandlerErrorDetail) => void;
    'bus.handler.async.enqueued': (detail: AsyncEnqueuedDetail) => void;
};
