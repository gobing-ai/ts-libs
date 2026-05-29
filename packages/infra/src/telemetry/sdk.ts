/**
 * OpenTelemetry SDK initialisation and tracer provider management.
 */
import { type Tracer, trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { TelemetryConfig } from './config';
import { getTelemetryConfig } from './config';

let tracerProvider: NodeTracerProvider | undefined;
let telemetryInitialized = false;
let resolvedConfig: TelemetryConfig = getTelemetryConfig();

const DEFAULT_TRACER = trace.getTracer('@gobing-ai/ts-infra', '0.1.0');

export function getResolvedConfig(): TelemetryConfig {
    return resolvedConfig;
}

export function initTelemetry(config?: Partial<TelemetryConfig>): void {
    if (telemetryInitialized) return;

    resolvedConfig = { ...getTelemetryConfig(), ...config };

    if (!resolvedConfig.enabled) {
        telemetryInitialized = true;
        return;
    }

    tracerProvider = new NodeTracerProvider();
    tracerProvider.register();
    telemetryInitialized = true;
}

export async function shutdownTelemetry(): Promise<void> {
    if (!tracerProvider) {
        telemetryInitialized = false;
        return;
    }
    await tracerProvider.shutdown();
    tracerProvider = undefined;
    telemetryInitialized = false;
}

export function getTracer(): Tracer {
    return tracerProvider?.getTracer('@gobing-ai/ts-infra', '0.1.0') ?? DEFAULT_TRACER;
}

export function isTelemetryEnabled(): boolean {
    return telemetryInitialized && resolvedConfig.enabled;
}

export function _resetTelemetry(): void {
    if (tracerProvider) {
        try {
            tracerProvider.shutdown();
        } catch {
            /* swallow */
        }
        tracerProvider = undefined;
    }
    telemetryInitialized = false;
    resolvedConfig = getTelemetryConfig();
}

export { context, propagation, trace } from '@opentelemetry/api';
