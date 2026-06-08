/**
 * Portable application bootstrap types.
 *
 * These types define the DI contract for `runApplication` — a thin orchestration
 * layer over existing ts-infra primitives. The portable subpath does not import
 * any runtime-specific adapters; everything injectable comes through the options.
 *
 * @module application/types
 */

import type { EventBus } from '../event-bus/event-bus';
import type { BusLifecycleEvents, EventMap } from '../event-bus/types';
import type { InfraEvents } from '../events';
import type { Logger, LogLevel } from '../logger';
import type { SchedulerAdapter } from '../scheduler/types';

// ── Feature flag option groups ────────────────────────────────────────────

/** Logging feature flags. */
export interface LoggingOptions {
    /** Enable logging. Default `true`. */
    enabled?: boolean;
    /** Minimum log level. Default `'info'`. */
    level?: LogLevel;
    /** Enable console output. Default `true`. */
    console?: boolean;
    /**
     * File sink writer. The portable bootstrap never opens files — the caller
     * (or Node convenience subpath) provides a writer.
     */
    fileSink?: (line: string) => void;
    /** JSON Lines format. Default `true`. */
    json?: boolean;
}

/** Event bus feature flags. */
export interface EventsOptions<TEvents extends EventMap = InfraEvents> {
    /** Enable event bus. Default `true`. */
    enabled?: boolean;
    /** Create and attach a lifecycle bus. Default `true`. */
    lifecycle?: boolean;
    /** Attach default observers (log + telemetry). Default `true`. */
    defaultObservers?: boolean;
    /** Pre-built event bus (skips creation when provided). */
    bus?: EventBus<TEvents>;
}

/** Telemetry feature flags. */
export interface TelemetryOptions {
    /** Enable telemetry instrumentation. Default `true`. */
    enabled?: boolean;
    /** Service name for spans. Default `'ts-libs'`. */
    serviceName?: string;
    /** Deployment environment. Default `'development'`. */
    environment?: string;
    /** Capture sanitized SQL in DB spans. Default `false`. */
    dbStatementDebug?: boolean;
}

/** Scheduler feature flags. */
export interface SchedulerOptions {
    /** Enable scheduler. Default `false`. */
    enabled?: boolean;
    /** Injected adapter (skips noop default when provided). */
    adapter?: SchedulerAdapter;
    /** Cron entries to register: `[cron, action][]`. */
    entries?: Array<[string, () => Promise<void>]>;
    /** Start scheduler immediately after registration. Default `true` when enabled. */
    autoStart?: boolean;
}

// ── Resolved bootstrap config ─────────────────────────────────────────────

/**
 * Fully-resolved bootstrap config (all optionals filled with defaults).
 * Constructed internally by `resolveBootstrapConfig`.
 */
export interface ApplicationBootstrapConfig {
    readonly logging: Readonly<
        Required<Pick<LoggingOptions, 'enabled' | 'level' | 'console' | 'json'>> & { fileSink?: (line: string) => void }
    >;
    readonly events: { enabled: boolean; lifecycle: boolean; defaultObservers: boolean };
    readonly telemetry: { enabled: boolean; serviceName: string; environment: string; dbStatementDebug: boolean };
    readonly scheduler: { enabled: boolean; autoStart: boolean };
}

// ── Injected services ─────────────────────────────────────────────────────

/** Services that may be pre-injected instead of created by the bootstrap. */
export interface ApplicationServices<TEvents extends EventMap = InfraEvents> {
    logger?: Logger;
    events?: EventBus<TEvents>;
    lifecycleBus?: EventBus<BusLifecycleEvents>;
    db?: DbAdapterLike;
    scheduler?: SchedulerAdapter;
}

/**
 * Minimal DB adapter shape the bootstrap cares about: `close()` for lifecycle.
 * This avoids importing `ts-db` (an optional peer) from the portable subpath.
 */
export interface DbAdapterLike {
    close(): void;
}

// ── Stop reason ───────────────────────────────────────────────────────────

/** Why the application is stopping. */
export type ApplicationStopReason = 'manual' | 'signal' | 'error' | 'shutdown';

// ── Runtime handle ────────────────────────────────────────────────────────

/**
 * Runtime handle returned by `runApplication`.
 *
 * Exposes all resolved services and a `stop()` method for graceful shutdown.
 */
export interface ApplicationRuntime<TAppConfig = unknown, TEvents extends EventMap = InfraEvents> {
    /** Fully-resolved bootstrap config (feature flags + defaults). */
    readonly config: ApplicationBootstrapConfig;
    /** Caller-provided application config, or `undefined`. */
    readonly appConfig: TAppConfig;
    /** Structured logger. */
    readonly logger: Logger;
    /** Application event bus. */
    readonly events: EventBus<TEvents>;
    /** Lifecycle bus (when enabled). */
    readonly lifecycleBus?: EventBus<BusLifecycleEvents>;
    /** DB adapter (when enabled and injected). */
    readonly db?: DbAdapterLike;
    /** Scheduler adapter (when enabled). */
    readonly scheduler?: SchedulerAdapter;
    /** Graceful shutdown. Idempotent — safe to call multiple times. */
    stop(reason?: ApplicationStopReason): Promise<void>;
}

// ── Options ───────────────────────────────────────────────────────────────

/**
 * Options for the portable `runApplication`.
 */
export interface ApplicationBootstrapOptions<TAppConfig = unknown, TEvents extends EventMap = InfraEvents> {
    /** Bootstrap feature flags (partial — defaults applied internally). */
    readonly config?: {
        logging?: LoggingOptions;
        events?: EventsOptions<TEvents>;
        telemetry?: TelemetryOptions;
        scheduler?: SchedulerOptions;
    };
    /** Already-resolved application config. Portable — no file reads. */
    readonly appConfig?: TAppConfig;
    /** Pre-built services to inject instead of creating defaults. */
    readonly services?: Partial<ApplicationServices<TEvents>>;
    /** User callback: application logic. Called after all services are ready. */
    readonly start: (app: ApplicationRuntime<TAppConfig, TEvents>) => Promise<void> | void;
    /** User callback: cleanup before services shut down. */
    readonly stop?: (
        app: ApplicationRuntime<TAppConfig, TEvents>,
        reason: ApplicationStopReason,
    ) => Promise<void> | void;
}

// ── Config validation (Node/Bun convenience subpath) ──────────────────────

/**
 * Validation result matching the structural `safeParse` pattern.
 * Avoids hard-coupling to a specific validation library.
 */
export interface ConfigValidationResult<T> {
    readonly success: boolean;
    readonly data?: T;
    readonly errors?: ReadonlyArray<{ path: string; message: string }>;
}

/**
 * Config validator: structural `safeParse`-compatible adapter.
 * Accepts any validation library that produces `{ success, data?, errors? }`.
 */
export type ApplicationConfigValidator<TAppConfig> =
    | { safeParse(raw: unknown): ConfigValidationResult<TAppConfig> }
    | ((raw: unknown) => TAppConfig)
    | { validate(raw: unknown): TAppConfig }
    | { parse(raw: unknown): TAppConfig };

/**
 * Config loader options for the Node/Bun convenience subpath.
 */
export interface ApplicationConfigLoader<TAppConfig = unknown> {
    /** Path to the YAML config file. */
    readonly configFile?: string;
    /** YAML section name for bootstrap config. Default `'bootstrap'`. */
    readonly bootstrapSection?: string;
    /** YAML section name for app-specific config. Default: remaining object. */
    readonly appSection?: string;
    /** Caller-provided validator for the app config section. */
    readonly appConfig?: ApplicationConfigValidator<TAppConfig>;
    /** Override values merged after loading. */
    readonly overrides?: Record<string, unknown>;
}

// Re-export event types needed by consumers
export type { BusLifecycleEvents, EventMap } from '../event-bus/types';
export type { InfraEvents } from '../events';
