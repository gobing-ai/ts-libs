/**
 * Event bus types — shared constraints for typed pub-sub.
 */

import type { WithEventSeverity } from '@gobing-ai/ts-utils';

/** Type constraint for event maps — keys are event names, values are listener signatures. */
export type EventMap = Record<string, (...args: never[]) => void>;

/** Options for subscribing to an event, including async dispatch mode. */
export interface SubscribeOptions {
    /** When true, the handler is dispatched through the async handler path. */
    async?: boolean;
    /**
     * Stable identifier for an async handler. Used as the `handlerId` in jobs
     * enqueued through an injected `JobQueue`, so a queue consumer (see
     * `EventBus.createJobHandler`) can dispatch jobs back to this handler —
     * including after a process restart. Anonymous async handlers get a
     * process-local generated id that is NOT stable across restarts.
     * Must be unique per bus instance.
     */
    name?: string;
}

/** Payload shape the bus enqueues for queue-backed async handlers. */
export interface AsyncEventJobPayload {
    /** Event name the handler was subscribed to. */
    event: string;
    /** Arguments the event was emitted with. */
    args: unknown[];
    /** Async handler id (subscription `name` or a generated id). */
    handlerId: string;
}

// ── Lifecycle events ────────────────────────────────────────────────

/** Payload emitted on `bus.emit.done` after synchronous handlers complete. */
export interface EmitDoneDetail extends WithEventSeverity {
    event: string;
    syncCount: number;
    asyncCount: number;
    emitDurationMs: number;
    errors: number;
    detail?: unknown;
}

/** Payload emitted on `bus.handler.error` when a handler throws. */
export interface HandlerErrorDetail extends WithEventSeverity {
    event: string;
    mode: 'sync' | 'async';
    error: string;
}

/** Payload emitted on `bus.handler.async.enqueued` when async handlers are scheduled. */
export interface AsyncEnqueuedDetail extends WithEventSeverity {
    event: string;
    jobId: string;
    handlerCount: number;
}

/** Strongly-typed lifecycle events emitted by the event bus. */
export type BusLifecycleEvents = {
    'bus.emit.done': (detail: EmitDoneDetail) => void;
    'bus.emit.noop': (detail: { event: string } & WithEventSeverity) => void;
    'bus.handler.error': (detail: HandlerErrorDetail) => void;
    'bus.handler.async.enqueued': (detail: AsyncEnqueuedDetail) => void;
};
