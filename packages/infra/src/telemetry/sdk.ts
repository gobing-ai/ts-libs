/**
 * Telemetry enablement + tracer access.
 *
 * The core only *instruments* against whatever tracer provider is registered
 * globally — it never constructs or owns a provider. Provider + exporter wiring
 * is the consumer's concern: either the host app registers its own OTel SDK, or
 * it opts into `@gobing-ai/ts-infra/otel-node` for turnkey OTLP export. This
 * keeps the main barrel free of any SDK runtime dependency.
 */
import { type Tracer, trace } from '@opentelemetry/api';
import type { TelemetryConfig } from './config';
import { getTelemetryConfig } from './config';

const TRACER_NAME = '@gobing-ai/ts-infra';
const TRACER_VERSION = '0.1.0';

let telemetryInitialized = false;
let resolvedConfig: TelemetryConfig = getTelemetryConfig();

export function getResolvedConfig(): TelemetryConfig {
    return resolvedConfig;
}

/**
 * Resolve telemetry config and mark telemetry enabled. Does not register any
 * provider — spans flow to the globally-registered provider (none ⇒ no-op).
 */
export function initTelemetry(config?: Partial<TelemetryConfig>): void {
    if (telemetryInitialized) return;
    resolvedConfig = { ...getTelemetryConfig(), ...config };
    telemetryInitialized = true;
}

export function shutdownTelemetry(): Promise<void> {
    telemetryInitialized = false;
    return Promise.resolve();
}

/** The infra tracer from the globally-registered provider (no-op when none). */
export function getTracer(): Tracer {
    return trace.getTracer(TRACER_NAME, TRACER_VERSION);
}

export function isTelemetryEnabled(): boolean {
    return telemetryInitialized && resolvedConfig.enabled;
}

export function _resetTelemetry(): void {
    telemetryInitialized = false;
    resolvedConfig = getTelemetryConfig();
}

export { context, propagation, trace } from '@opentelemetry/api';
