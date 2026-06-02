/**
 * OpenTelemetry metrics — lazy-initialized instruments.
 * All degrade to no-ops when telemetry is disabled.
 */
import { type Counter, type Histogram, metrics } from '@opentelemetry/api';

export type { Counter, Histogram } from '@opentelemetry/api';

let metricsInitialized = false;

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

export function getHttpClientRequestTotal(): Counter {
    return getOrCreateCounter('httpCliReq', 'http.client.request.total', 'Total outbound HTTP requests', '{request}');
}

export function getHttpClientRequestDuration(): Histogram {
    return getOrCreateHistogram('httpCliDur', 'http.client.request.duration', 'Outbound HTTP request duration');
}

export function getHttpClientRequestErrors(): Counter {
    return getOrCreateCounter('httpCliErr', 'http.client.request.errors', 'Outbound HTTP errors', '{error}');
}

// ── Event bus ───────────────────────────────────────────────────────

export function getEventbusEmitsTotal(): Counter {
    return getOrCreateCounter('ebEmit', 'eventbus.emits.total', 'Total event bus emits', '{emit}');
}

export function getEventbusErrorsTotal(): Counter {
    return getOrCreateCounter('ebErr', 'eventbus.errors.total', 'Event bus errors', '{error}');
}

// ── Queue ───────────────────────────────────────────────────────────

export function getQueueJobEnqueuedTotal(): Counter {
    return getOrCreateCounter('qEnq', 'queue.jobs.enqueued', 'Total jobs enqueued', '{job}');
}

export function getQueueJobCompletedTotal(): Counter {
    return getOrCreateCounter('qComp', 'queue.jobs.completed', 'Total jobs completed', '{job}');
}

export function getQueueJobFailedTotal(): Counter {
    return getOrCreateCounter('qFail', 'queue.jobs.failed', 'Total jobs failed', '{job}');
}

export function getQueueJobProcessingDuration(): Histogram {
    return getOrCreateHistogram('qProcDur', 'queue.jobs.processing_duration', 'Job processing duration');
}

// ── Scheduler ───────────────────────────────────────────────────────

export function getSchedulerJobExecutedTotal(): Counter {
    return getOrCreateCounter('schedExec', 'scheduler.jobs.executed', 'Total scheduled job executions', '{execution}');
}

export function getSchedulerJobDuration(): Histogram {
    return getOrCreateHistogram('schedDur', 'scheduler.jobs.duration', 'Scheduled job duration');
}

export function getSchedulerJobFailedTotal(): Counter {
    return getOrCreateCounter('schedFail', 'scheduler.jobs.failed', 'Failed scheduled jobs', '{failure}');
}

// ── Lifecycle ───────────────────────────────────────────────────────

export function initMetrics(): void {
    if (metricsInitialized) return;
    metricsInitialized = true;
}

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

export function _resetMetrics(): void {
    for (const key of Object.keys(instruments)) {
        instruments[key] = undefined;
    }
    metricsInitialized = false;
    metrics.disable();
}
