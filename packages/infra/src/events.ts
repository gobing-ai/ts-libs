/**
 * Infrastructure-level event definitions for ts-infra observability.
 *
 * These maps define the infra-level event *contract* for the consumers of
 * `@gobing-ai/ts-infra`. ts-infra emits `queue.*` (DBJobQueue / DBQueueConsumer),
 * `scheduler.job.executed` (`wrapScheduledHandler`), and `db.connection.error`
 * (DB wiring). Application-domain events (history import, HTTP server, …) belong
 * to the consuming app, not this library. Process events belong to
 * `@gobing-ai/ts-runtime` (the owner of `ProcessExecutor`) and are intentionally
 * not re-exported here.
 *
 * **Metadata-only invariant:** every `queue.*` detail object is correlator-grade —
 * it carries job identity, timing, and retry counters only, and NEVER embeds the
 * job business payload `T` (which may contain prompts, tokens, PII, or large
 * blobs). Inspect job bodies via the Jobs DAO when needed.
 *
 * Consume via `EventBus<InfraEvents>` or compose individual maps into a wider
 * app event map.
 */

import type { EventSeverity, WithEventSeverity } from '@gobing-ai/ts-utils';
import type { QueueStats } from './job-queue/types';

export type { EventSeverity, WithEventSeverity };

// ── Detail payloads ────────────────────────────────────────────────────────

/** Payload for `db.connection.error`. */
export interface DbConnectionErrorDetail extends WithEventSeverity {
    /** Error message. */
    error: string;
    /** Adapter type (e.g. 'sqlite', 'd1'). */
    adapter: string;
}

/** Shared job identity correlators present on every `queue.job.*` event. */
export interface QueueJobRef {
    /** Job id. */
    jobId: string;
    /** Job type (the handler registration key). */
    type: string;
}

/** Payload for `queue.job.enqueued` — a new job was added to the queue. */
export interface QueueJobEnqueuedDetail extends QueueJobRef, WithEventSeverity {
    /** Epoch ms when the job was enqueued. */
    enqueuedAt: number;
    /** Max retry count from `EnqueueOptions.maxRetries`, when supplied. */
    maxRetries?: number;
    /** Requested delay before the job becomes ready (ms), from `EnqueueOptions.delay`. */
    delayMs?: number;
    /** Job TTL in ms, from `EnqueueOptions.ttlMs`. */
    ttlMs?: number;
}

/** Payload for `queue.consumer.started` — the polling loop began. */
export interface QueueConsumerStartedDetail extends WithEventSeverity {
    /** Epoch ms when the consumer was started. */
    startedAt: number;
    /** Polling interval in ms. */
    pollInterval: number;
    /** Claim batch size per poll cycle. */
    batchSize: number;
    /** Maximum concurrent in-flight handlers. */
    maxConcurrency: number;
    /** Visibility-timeout window in ms. */
    visibilityTimeout: number;
}

/** Payload for `queue.consumer.stopped` — the polling loop was halted. */
export interface QueueConsumerStoppedDetail extends WithEventSeverity {
    /** Epoch ms when `stop()` was called. */
    stoppedAt: number;
    /** Drain deadline in ms applied to in-flight handlers at stop time. */
    drainTimeoutMs: number;
    /** In-flight handler count observed at stop time. */
    inFlightAtStop: number;
    /** `true` when all in-flight handlers completed within the drain deadline. */
    drained: boolean;
}

/** Payload for `queue.job.completed` — a job ran to success. */
export interface QueueJobCompletedDetail extends QueueJobRef, WithEventSeverity {
    /** Handler wall-clock duration in ms. */
    durationMs: number;
    /** Attempts counter on the job row at success (0 on the first successful run). */
    attempt: number;
}

/** Payload for `queue.job.failed` — a job exhausted retries. */
export interface QueueJobFailedDetail extends QueueJobRef, WithEventSeverity {
    /** Error message from the final attempt. */
    error: string;
    /** 1-based attempt number of the failure. */
    attempt: number;
    /** Maximum retry count configured for the job. */
    maxRetries: number;
    /** Handler wall-clock duration in ms, when measured at the failing attempt. */
    durationMs?: number;
}

/** Payload for `queue.job.retrying` — a job will be retried after backoff. */
export interface QueueJobRetryingDetail extends QueueJobRef, WithEventSeverity {
    /** 1-based attempt number of the failure that triggers this retry. */
    attempt: number;
    /** Maximum retry count configured for the job. */
    maxRetries: number;
    /** When the next retry will fire (epoch ms). */
    nextRetryAt: number;
    /** Error message that caused this retry. */
    error: string;
}

/** Payload for `scheduler.job.executed`. */
export interface SchedulerJobExecutedDetail extends WithEventSeverity {
    /** Job name. */
    name: string;
    /** Wall-clock duration in milliseconds. */
    durationMs: number;
    /** Error message if the job threw. */
    error?: string;
}

/** Payload for `api.request.error`. */
export interface ApiRequestErrorDetail extends WithEventSeverity {
    url: string;
    method: string;
    /** HTTP status code, if a response was received. */
    status?: number;
    error: string;
}

// ── Event maps ─────────────────────────────────────────────────────────────

/** Database lifecycle events emitted by DB-facing infra wiring. */
export type DbEvents = {
    /** Database connection established. */
    'db.connected': () => void;
    /** Database connection error. */
    'db.connection.error': (detail: DbConnectionErrorDetail) => void;
};

/** Job-queue lifecycle events emitted by the queue and its consumer. */
export type QueueEvents = {
    /** A new job was enqueued. */
    'queue.job.enqueued': (detail: QueueJobEnqueuedDetail) => void;
    /** Consumer polling loop started. */
    'queue.consumer.started': (detail: QueueConsumerStartedDetail) => void;
    /** Consumer polling loop stopped. */
    'queue.consumer.stopped': (detail: QueueConsumerStoppedDetail) => void;
    /** A job completed successfully. */
    'queue.job.completed': (detail: QueueJobCompletedDetail) => void;
    /** A job exhausted retries and is permanently failed. */
    'queue.job.failed': (detail: QueueJobFailedDetail) => void;
    /** A job will be retried after backoff. */
    'queue.job.retrying': (detail: QueueJobRetryingDetail) => void;
    /** Queue depth snapshot emitted on a poll cycle. */
    'queue.stats': (detail: QueueStats & WithEventSeverity) => void;
};

/** Scheduler events emitted by scheduler adapters and the handler wrapper. */
export type SchedulerEvents = {
    /** A scheduled job was executed (success or failure). */
    'scheduler.job.executed': (detail: SchedulerJobExecutedDetail) => void;
};

/** API-client events. */
export type ApiClientEvents = {
    /** An API request failed (non-2xx or network error). */
    'api.request.error': (detail: ApiRequestErrorDetail) => void;
};

/**
 * Aggregate of all infrastructure-level event maps ts-infra emits. Use with
 * `EventBus<InfraEvents>`, or pick individual maps when composing a wider app
 * event map.
 */
export type InfraEvents = DbEvents & QueueEvents & SchedulerEvents & ApiClientEvents;
