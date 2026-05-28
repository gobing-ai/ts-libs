/**
 * Event bus types — shared constraints for typed pub-sub.
 */

export type EventMap = Record<string, (...args: never[]) => void>;

export interface SubscribeOptions {
    /** When true, the handler is dispatched asynchronously via the job queue. */
    async?: boolean;
}

// ── Lifecycle events ────────────────────────────────────────────────

export interface EmitDoneDetail {
    event: string;
    syncCount: number;
    asyncCount: number;
    emitDurationMs: number;
    errors: number;
    detail?: unknown;
}

export interface HandlerErrorDetail {
    event: string;
    mode: 'sync' | 'async';
    error: string;
}

export interface AsyncEnqueuedDetail {
    event: string;
    jobId: string;
    handlerCount: number;
}

export type BusLifecycleEvents = {
    'bus.emit.done': (detail: EmitDoneDetail) => void;
    'bus.emit.noop': (detail: { event: string }) => void;
    'bus.handler.error': (detail: HandlerErrorDetail) => void;
    'bus.handler.async.enqueued': (detail: AsyncEnqueuedDetail) => void;
};
