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

// ── Configuration ───────────────────────────────────────────────────────────

/**
 * Full telemetry configuration: master enable switch, service name,
 * environment, and debug-level DB statement capture.
 */
export interface TelemetryConfig {
    /**
     * Master switch — when false, infra-created spans and metric instruments
     * degrade to no-ops even if a global OTel provider is registered.
     * Explicitly injected tracer ports (ADR-009 addendum) are unaffected.
     */
    enabled: boolean;
    /** Logical service name emitted on every span. */
    serviceName: string;
    /** Deployment environment (development, staging, production). */
    environment: string;
    /**
     * Debug-only DB statement capture.
     *
     * When true, DB spans may include sanitized SQL text in a `db.statement`
     * attribute. SQL text is redacted — parameter values, literals, and
     * identifiers are stripped before capture.
     *
     * Default: `false`. Set via config — ts-infra core never reads env vars
     * (ADR-011); map an env var to this flag in your bootstrap if desired.
     */
    dbStatementDebug: boolean;
}

/** Partial telemetry config from the centralized config system. */
export interface TelemetryConfigPartial {
    enabled?: boolean | undefined;
    serviceName?: string | undefined;
    environment?: string | undefined;
    dbStatementDebug?: boolean | undefined;
    /** Deployment environment fallback (from app.env). */
    appEnv?: string | undefined;
}

const CONFIG_DEFAULTS = {
    enabled: true as const,
    serviceName: 'ts-libs' as const,
    environment: 'development' as const,
};

/** Resolve the full telemetry config by merging a partial override with defaults. */
export function getTelemetryConfig(configPartial: TelemetryConfigPartial = {}): TelemetryConfig {
    return {
        enabled: configPartial.enabled ?? CONFIG_DEFAULTS.enabled,
        serviceName: configPartial.serviceName ?? CONFIG_DEFAULTS.serviceName,
        environment: configPartial.environment ?? configPartial.appEnv ?? CONFIG_DEFAULTS.environment,
        dbStatementDebug: configPartial.dbStatementDebug ?? false,
    };
}

const TRACER_NAME = '@gobing-ai/ts-infra';
const TRACER_VERSION = '0.1.0';

let telemetryInitialized = false;
let resolvedConfig: TelemetryConfig = getTelemetryConfig();

/** Get the resolved telemetry configuration (defaults + overrides). */
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

/** Mark telemetry as uninitialized. Does not shut down the OTel provider. */
export function shutdownTelemetry(): Promise<void> {
    telemetryInitialized = false;
    return Promise.resolve();
}

/** The infra tracer from the globally-registered provider (no-op when none). */
export function getTracer(): Tracer {
    return trace.getTracer(TRACER_NAME, TRACER_VERSION);
}

/** Whether telemetry is initialized and enabled. */
export function isTelemetryEnabled(): boolean {
    return telemetryInitialized && resolvedConfig.enabled;
}

/** Reset the telemetry subsystem to its uninitialized state. For testing. */
export function _resetTelemetry(): void {
    telemetryInitialized = false;
    resolvedConfig = getTelemetryConfig();
}

export { context, propagation, trace } from '@opentelemetry/api';
