/**
 * Infrastructure-level event definitions for ts-infra observability.
 *
 * Mirrors the package-local pattern in `@gobing-ai/ts-ai-runner` (`events.ts`):
 * only the events ts-infra components actually emit live here. Application-domain
 * events (history import, HTTP server, …) belong to the consuming app, not this
 * library. Process events belong to `@gobing-ai/ts-runtime` (the owner of
 * `ProcessExecutor`) and are intentionally not re-exported here.
 *
 * Consume via `EventBus<InfraEvents>` or compose individual maps into a wider
 * app event map.
 */

import type { QueueStats } from './job-queue/types';

// ── Detail payloads ────────────────────────────────────────────────────────

/** Payload for `db.connection.error`. */
export interface DbConnectionErrorDetail {
    /** Error message. */
    error: string;
    /** Adapter type (e.g. 'sqlite', 'd1'). */
    adapter: string;
}

/** Payload for `queue.job.failed` — a job exhausted retries. */
export interface QueueJobFailedDetail {
    jobId: string;
    type: string;
    error: string;
    /** Attempt number (0-indexed, incremented after each failure). */
    attempt: number;
}

/** Payload for `queue.job.retrying` — a job will be retried after backoff. */
export interface QueueJobRetryingDetail {
    jobId: string;
    type: string;
    attempt: number;
    /** When the next retry will fire (epoch ms). */
    nextRetryAt: number;
}

/** Payload for `scheduler.job.executed`. */
export interface SchedulerJobExecutedDetail {
    /** Job name. */
    name: string;
    /** Wall-clock duration in milliseconds. */
    durationMs: number;
    /** Error message if the job threw. */
    error?: string;
}

/** Payload for `api.request.error`. */
export interface ApiRequestErrorDetail {
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
    'queue.job.enqueued': (detail: { jobId: string; type: string }) => void;
    /** Consumer polling loop started. */
    'queue.consumer.started': () => void;
    /** Consumer stopped. */
    'queue.consumer.stopped': () => void;
    /** A job completed successfully. */
    'queue.job.completed': (detail: { jobId: string; type: string }) => void;
    /** A job exhausted retries and is permanently failed. */
    'queue.job.failed': (detail: QueueJobFailedDetail) => void;
    /** A job will be retried after backoff. */
    'queue.job.retrying': (detail: QueueJobRetryingDetail) => void;
    /** Queue depth snapshot emitted on a poll cycle. */
    'queue.stats': (detail: QueueStats) => void;
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
