/**
 * OpenTelemetry metrics — lazy-initialized instruments.
 * All degrade to no-ops when telemetry is disabled.
 */
import { type Counter, type Histogram, metrics } from '@opentelemetry/api';

export type { Counter, Histogram } from '@opentelemetry/api';

let metricsInitialized = false;

/** Whether the metrics subsystem has been initialized via {@link initMetrics}. */
export function isMetricsInitialized(): boolean {
    return metricsInitialized;
}

const METER_NAME = '@gobing-ai/ts-infra';
const METER_VERSION = '0.1.0';

/** Meter from the globally-registered provider (no-op when none registered). */
function getMeter() {
    return metrics.getMeter(METER_NAME, METER_VERSION);
}

// ── Instrument cache ────────────────────────────────────────────────

const instruments: Record<string, Counter | Histogram | undefined> = {};

function getOrCreateCounter(key: string, name: string, description: string, unit = '{operation}'): Counter {
    if (!instruments[key]) {
        instruments[key] = getMeter().createCounter(name, { description, unit });
    }
    return instruments[key] as Counter;
}

function getOrCreateHistogram(key: string, name: string, description: string, unit = 'ms'): Histogram {
    if (!instruments[key]) {
        instruments[key] = getMeter().createHistogram(name, { description, unit });
    }
    return instruments[key] as Histogram;
}

// ── HTTP client ─────────────────────────────────────────────────────

/** Counter for total outbound HTTP requests, tagged by method and status code. */
export function getHttpClientRequestTotal(): Counter {
    return getOrCreateCounter('httpCliReq', 'http.client.request.total', 'Total outbound HTTP requests', '{request}');
}

/** Histogram for outbound HTTP request duration in milliseconds. */
export function getHttpClientRequestDuration(): Histogram {
    return getOrCreateHistogram('httpCliDur', 'http.client.request.duration', 'Outbound HTTP request duration');
}

/** Counter for outbound HTTP errors, tagged by error type. */
export function getHttpClientRequestErrors(): Counter {
    return getOrCreateCounter('httpCliErr', 'http.client.request.errors', 'Outbound HTTP errors', '{error}');
}

// ── Event bus ───────────────────────────────────────────────────────

/** Counter for total event bus emits. */
export function getEventbusEmitsTotal(): Counter {
    return getOrCreateCounter('ebEmit', 'eventbus.emits.total', 'Total event bus emits', '{emit}');
}

/** Counter for event bus handler errors. */
export function getEventbusErrorsTotal(): Counter {
    return getOrCreateCounter('ebErr', 'eventbus.errors.total', 'Event bus errors', '{error}');
}

// ── Queue ───────────────────────────────────────────────────────────

/** Counter for total jobs enqueued. */
export function getQueueJobEnqueuedTotal(): Counter {
    return getOrCreateCounter('qEnq', 'queue.jobs.enqueued', 'Total jobs enqueued', '{job}');
}

/** Counter for total jobs completed successfully. */
export function getQueueJobCompletedTotal(): Counter {
    return getOrCreateCounter('qComp', 'queue.jobs.completed', 'Total jobs completed', '{job}');
}

/** Counter for total jobs that failed (exhausted retries). */
export function getQueueJobFailedTotal(): Counter {
    return getOrCreateCounter('qFail', 'queue.jobs.failed', 'Total jobs failed', '{job}');
}

/** Histogram for job processing duration in milliseconds. */
export function getQueueJobProcessingDuration(): Histogram {
    return getOrCreateHistogram('qProcDur', 'queue.jobs.processing_duration', 'Job processing duration');
}

// ── Scheduler ───────────────────────────────────────────────────────

/** Counter for total scheduled job executions. */
export function getSchedulerJobExecutedTotal(): Counter {
    return getOrCreateCounter('schedExec', 'scheduler.jobs.executed', 'Total scheduled job executions', '{execution}');
}

/** Histogram for scheduled job execution duration in milliseconds. */
export function getSchedulerJobDuration(): Histogram {
    return getOrCreateHistogram('schedDur', 'scheduler.jobs.duration', 'Scheduled job duration');
}

/** Counter for failed scheduled job executions. */
export function getSchedulerJobFailedTotal(): Counter {
    return getOrCreateCounter('schedFail', 'scheduler.jobs.failed', 'Failed scheduled jobs', '{failure}');
}

// ── Lifecycle ───────────────────────────────────────────────────────

/**
 * Pre-warm every instrument against the currently-registered meter and mark the
 * subsystem initialized. Idempotent.
 *
 * Instruments are otherwise created lazily on first getter call (so metrics keep
 * working even if this is never called — see the module contract). Calling this
 * during bootstrap eagerly materializes them, so `isMetricsInitialized()` reflects
 * real wiring rather than being a flag that gates nothing.
 */
export function initMetrics(): void {
    if (metricsInitialized) return;
    // Eagerly materialize all instruments against the live meter.
    getHttpClientRequestTotal();
    getHttpClientRequestDuration();
    getHttpClientRequestErrors();
    getEventbusEmitsTotal();
    getEventbusErrorsTotal();
    getQueueJobEnqueuedTotal();
    getQueueJobCompletedTotal();
    getQueueJobFailedTotal();
    getQueueJobProcessingDuration();
    getSchedulerJobExecutedTotal();
    getSchedulerJobDuration();
    getSchedulerJobFailedTotal();
    metricsInitialized = true;
}

/** Clear the instrument cache and mark metrics as uninitialized. */
export function shutdownMetrics(): Promise<void> {
    // The meter provider is owned by whoever registered it globally (the host
    // app or `@gobing-ai/ts-infra/otel-node`). Here we only drop the instrument
    // cache so post-shutdown getters rebuild against a fresh meter.
    for (const key of Object.keys(instruments)) {
        instruments[key] = undefined;
    }
    metricsInitialized = false;
    return Promise.resolve();
}

/**
 * Reset all metrics state: clear instrument cache, mark uninitialized,
 * and disable the global meter. For testing only.
 */
export function _resetMetrics(): void {
    for (const key of Object.keys(instruments)) {
        instruments[key] = undefined;
    }
    metricsInitialized = false;
    metrics.disable();
}
