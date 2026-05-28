/**
 * Telemetry configuration interface.
 */

export interface TelemetryConfig {
    /** Master switch — when false, all tracing degrades to no-ops. */
    enabled: boolean;
    /** Logical service name emitted on every span. */
    serviceName: string;
    /** Deployment environment (development, staging, production). */
    environment: string;
    /** OTLP exporter endpoint (e.g. `http://localhost:4318/v1/traces`). */
    exporterEndpoint?: string | undefined;
    /** Export protocol — only `http` is supported in v1. */
    exporterProtocol: 'http';
    /**
     * Debug-only DB statement capture.
     *
     * When true, DB spans may include sanitized SQL text in a `db.statement`
     * attribute. SQL text is redacted — parameter values, literals, and
     * identifiers are stripped before capture.
     *
     * Default: `false`. Controlled by `OTEL_DB_STATEMENT_DEBUG` env var.
     */
    dbStatementDebug: boolean;
}

/**
 * Partial telemetry config from the centralized config system.
 */
export interface TelemetryConfigPartial {
    enabled?: boolean | undefined;
    serviceName?: string | undefined;
    environment?: string | undefined;
    exporterEndpoint?: string | undefined;
    dbStatementDebug?: boolean | undefined;
    /** Deployment environment fallback (from app.env). */
    appEnv?: string | undefined;
}

const DEFAULTS = {
    enabled: true as const,
    serviceName: 'ts-libs' as const,
    environment: 'development' as const,
    exporterProtocol: 'http' as const,
};

/**
 * Resolve the full telemetry config by merging a partial override with defaults.
 */
export function getTelemetryConfig(configPartial: TelemetryConfigPartial = {}): TelemetryConfig {
    const enabled = configPartial.enabled ?? DEFAULTS.enabled;
    const serviceName = configPartial.serviceName ?? DEFAULTS.serviceName;

    return {
        enabled,
        serviceName,
        environment: configPartial.environment ?? configPartial.appEnv ?? DEFAULTS.environment,
        exporterEndpoint: configPartial.exporterEndpoint,
        exporterProtocol: DEFAULTS.exporterProtocol,
        dbStatementDebug: configPartial.dbStatementDebug ?? false,
    };
}
