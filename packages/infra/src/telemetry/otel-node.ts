/**
 * Opt-in Node OTLP wiring for `@gobing-ai/ts-infra`.
 *
 * The core telemetry surface (`initTelemetry`, `getTracer`, the metric getters)
 * only *instruments* — it records spans and metrics against whatever OTel
 * provider is registered globally, and degrades to no-ops when none is. This
 * subpath is the convenience layer that actually *exports*: it builds Node
 * tracer + meter providers wired to OTLP/HTTP and registers them globally, so
 * the already-instrumented call sites start flowing without any core change.
 *
 * Import this only when you want turnkey export. It pulls the OTLP exporter
 * packages (declared as optional peers); the main barrel never imports them, so
 * BYO-collector consumers stay lean and avoid global-provider conflicts.
 */
import { metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, type MetricReader, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

/** Options for {@link initNodeTelemetry}. */
export interface NodeTelemetryOptions {
    /** Logical service name emitted on every span/metric (resource attribute). */
    serviceName: string;
    /** Optional service version (resource attribute). */
    serviceVersion?: string;
    /**
     * OTLP/HTTP collector endpoint base, e.g. `http://localhost:4318`.
     * Signal-specific paths (`/v1/traces`, `/v1/metrics`) are appended by the
     * exporters. When omitted, the OTel SDK default (`http://localhost:4318`)
     * applies, honouring the standard `OTEL_EXPORTER_OTLP_*` env vars.
     */
    endpoint?: string;
    /** Extra headers sent on every OTLP request (e.g. an auth token). */
    headers?: Record<string, string>;
    /** Metric export interval in ms. Default: 60_000. */
    metricExportIntervalMs?: number;
    /** When false, skip metric export and wire traces only. Default: true. */
    metrics?: boolean;
}

let traceProvider: NodeTracerProvider | undefined;
let meterProvider: MeterProvider | undefined;

/**
 * Wire Node OTLP/HTTP export for traces and (by default) metrics, registering
 * both providers globally. Idempotent: a second call is a no-op until
 * {@link shutdownNodeTelemetry} runs.
 *
 * Call once at process startup, before the first span/metric is recorded.
 */
export function initNodeTelemetry(options: NodeTelemetryOptions): void {
    if (traceProvider) return;

    const { serviceName, serviceVersion, endpoint, headers, metricExportIntervalMs = 60_000 } = options;
    const wireMetrics = options.metrics ?? true;

    const resource = resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
        ...(serviceVersion ? { [ATTR_SERVICE_VERSION]: serviceVersion } : {}),
    });

    const traceExporter = new OTLPTraceExporter({
        ...(endpoint ? { url: `${endpoint.replace(/\/$/, '')}/v1/traces` } : {}),
        ...(headers ? { headers } : {}),
    });

    traceProvider = new NodeTracerProvider({
        resource,
        spanProcessors: [new BatchSpanProcessor(traceExporter)],
    });
    traceProvider.register();

    if (wireMetrics) {
        const metricExporter = new OTLPMetricExporter({
            ...(endpoint ? { url: `${endpoint.replace(/\/$/, '')}/v1/metrics` } : {}),
            ...(headers ? { headers } : {}),
        });

        const reader: MetricReader = new PeriodicExportingMetricReader({
            exporter: metricExporter,
            exportIntervalMillis: metricExportIntervalMs,
        });

        meterProvider = new MeterProvider({ resource, readers: [reader] });
        metrics.setGlobalMeterProvider(meterProvider);
    }
}

/**
 * Flush and shut down the providers installed by {@link initNodeTelemetry}.
 * Safe to call when nothing was initialised. Wire this to SIGTERM/SIGINT for a
 * clean drain of buffered spans and metrics on shutdown.
 */
export async function shutdownNodeTelemetry(): Promise<void> {
    const pending: Array<Promise<void>> = [];
    if (meterProvider) {
        pending.push(meterProvider.shutdown());
        meterProvider = undefined;
    }
    if (traceProvider) {
        pending.push(traceProvider.shutdown());
        traceProvider = undefined;
    }
    metrics.disable();
    await Promise.all(pending);
}

/** Test-only: reset module state without requiring exporter teardown to resolve. */
export function _resetNodeTelemetry(): void {
    meterProvider = undefined;
    traceProvider = undefined;
    metrics.disable();
}
