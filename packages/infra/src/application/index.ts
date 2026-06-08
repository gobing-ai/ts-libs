/**
 * Portable `runApplication` — DI bootstrap over existing ts-infra primitives.
 *
 * Orchestrates logger, telemetry, event bus, (optional) DB adapter, and
 * (optional) scheduler into a deterministic startup/shutdown lifecycle.
 * The portable subpath never opens files, creates DB connections, or wires
 * runtime-specific exporters — those are injected or handled by the
 * Node/Bun convenience subpath.
 *
 * @module application
 */

import { attachDefaultObservers, createLifecycleBus } from '../event-bus/default-observers';
import { EventBus } from '../event-bus/event-bus';
import type { BusLifecycleEvents, EventMap } from '../event-bus/types';
import type { InfraEvents } from '../events';
import { getLogger, initializeLogger, type Logger } from '../logger';
import { initScheduler, setSchedulerAdapter } from '../scheduler/factory';
import type { SchedulerAdapter } from '../scheduler/types';
import { initTelemetry, shutdownTelemetry } from '../telemetry/sdk';
import type {
    ApplicationBootstrapConfig,
    ApplicationBootstrapOptions,
    ApplicationRuntime,
    ApplicationStopReason,
    DbAdapterLike,
} from './types';

// ── Internal runtime state ────────────────────────────────────────────────

interface RuntimeState<TAppConfig, TEvents extends EventMap> {
    app: ApplicationRuntime<TAppConfig, TEvents> | undefined;
    userStop?: (app: ApplicationRuntime<TAppConfig, TEvents>, reason: ApplicationStopReason) => Promise<void> | void;
    schedulerAdapter?: SchedulerAdapter;
    schedulerStarted: boolean;
    loggerInitialized: boolean;
    telemetryInitialized: boolean;
    stopped: boolean;
}

// ── Shutdown (deterministic reverse order per R5) ─────────────────────────

async function performShutdown<TAppConfig, TEvents extends EventMap>(
    state: RuntimeState<TAppConfig, TEvents>,
    reason: ApplicationStopReason,
): Promise<void> {
    if (state.stopped) return;
    state.stopped = true;

    const app = state.app;
    if (!app) return;

    // 1. User stop callback
    if (state.userStop) {
        await state.userStop(app, reason);
    }

    // 2. Stop scheduler
    if (state.schedulerStarted && state.schedulerAdapter) {
        await state.schedulerAdapter.stop().catch(() => {});
        state.schedulerStarted = false;
    }

    // 3. Close DB adapter
    if (app.db) {
        try {
            app.db.close();
        } catch {
            /* best-effort */
        }
    }

    // 4. Shutdown telemetry
    if (state.telemetryInitialized) {
        await shutdownTelemetry();
        state.telemetryInitialized = false;
    }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Portable application bootstrap.
 *
 * Orchestrates logger, telemetry, events, optional DB, and optional scheduler.
 * Accepts injected dependencies; never opens files, reads config from disk,
 * or wires runtime-specific exporters.
 *
 * Startup order (deterministic, per R5):
 * 1. Resolve bootstrap config + app config
 * 2. Initialize logger
 * 3. Initialize telemetry
 * 4. Create lifecycle bus + application EventBus
 * 5. Register DB adapter (injected only)
 * 6. Initialize scheduler + register entries
 * 7. Call user `start(app)` callback
 * 8. Start scheduler if `autoStart`
 *
 * Shutdown order (reverse, per R5):
 * 1. User `stop(app, reason)` callback
 * 2. Stop scheduler
 * 3. Close DB adapter
 * 4. Shut down telemetry
 *
 * If any startup step fails, already-started services are cleaned up in reverse
 * order before rethrowing. `stop()` is idempotent.
 *
 * @example
 * ```ts
 * import { runApplication } from '@gobing-ai/ts-infra/application';
 *
 * const app = await runApplication({
 *     config: { logging: { level: 'debug' } },
 *     async start(app) {
 *         app.logger.info('started');
 *     },
 * });
 * ```
 */
export async function runApplication<TAppConfig = unknown, TEvents extends EventMap = InfraEvents>(
    options: ApplicationBootstrapOptions<TAppConfig, TEvents>,
): Promise<ApplicationRuntime<TAppConfig, TEvents>> {
    // ── Resolve config ─────────────────────────────────────────────────

    const logOpts = options.config?.logging;
    const loggingConfig: ApplicationBootstrapConfig['logging'] = {
        enabled: logOpts?.enabled ?? true,
        level: logOpts?.level ?? 'info',
        console: logOpts?.console ?? true,
        json: logOpts?.json ?? true,
        ...(logOpts?.fileSink ? { fileSink: logOpts.fileSink } : {}),
    };

    const telOpts = options.config?.telemetry;
    const telemetryConfig: ApplicationBootstrapConfig['telemetry'] = {
        enabled: telOpts?.enabled ?? true,
        serviceName: telOpts?.serviceName ?? 'ts-libs',
        environment: telOpts?.environment ?? 'development',
        dbStatementDebug: telOpts?.dbStatementDebug ?? false,
    };

    const schedOpts = options.config?.scheduler;
    const schedulerConfig: ApplicationBootstrapConfig['scheduler'] = {
        enabled: schedOpts?.enabled ?? false,
        autoStart: schedOpts?.autoStart ?? true,
    };

    const eventsEnabled = options.config?.events?.enabled ?? true;
    const eventsLifecycle = options.config?.events?.lifecycle ?? true;
    const eventsDefaultObservers = options.config?.events?.defaultObservers ?? true;

    const state: RuntimeState<TAppConfig, TEvents> = {
        app: undefined,
        userStop: options.stop,
        schedulerAdapter: undefined,
        schedulerStarted: false,
        loggerInitialized: false,
        telemetryInitialized: false,
        stopped: false,
    };

    try {
        // ── 1. Initialize logger ────────────────────────────────────────
        let logger: Logger;
        if (options.services?.logger) {
            logger = options.services.logger;
        } else if (loggingConfig.enabled) {
            await initializeLogger({
                level: loggingConfig.level,
                console: loggingConfig.console,
                fileSink: loggingConfig.fileSink,
                json: loggingConfig.json,
            });
            logger = getLogger('bootstrap');
        } else {
            logger = getLogger('bootstrap');
        }

        // ── 2. Initialize telemetry ────────────────────────────────────
        if (telemetryConfig.enabled) {
            initTelemetry({
                enabled: telemetryConfig.enabled,
                serviceName: telemetryConfig.serviceName,
                environment: telemetryConfig.environment,
                dbStatementDebug: telemetryConfig.dbStatementDebug,
            });
            state.telemetryInitialized = true;
        }

        // ── 3. Create lifecycle bus + EventBus ─────────────────────────
        const lifecycleBus =
            eventsEnabled && eventsLifecycle ? (options.services?.lifecycleBus ?? createLifecycleBus()) : undefined;

        if (lifecycleBus && eventsDefaultObservers) {
            attachDefaultObservers(lifecycleBus);
        }

        const events = options.services?.events
            ? options.services.events
            : new EventBus<TEvents>({ lifecycleBus: lifecycleBus as EventBus<BusLifecycleEvents> | undefined });

        // ── 4. Database (injected only) ────────────────────────────────
        const db: DbAdapterLike | undefined = options.services?.db;

        // ── 5. Scheduler ───────────────────────────────────────────────
        let scheduler: SchedulerAdapter | undefined;
        if (schedulerConfig.enabled) {
            const adapter = options.services?.scheduler ?? schedOpts?.adapter;
            if (adapter) {
                setSchedulerAdapter(adapter);
            }
            scheduler = initScheduler(schedOpts?.entries);
            state.schedulerAdapter = scheduler;
        }

        // ── Build resolved config ──────────────────────────────────────
        const resolvedConfig: ApplicationBootstrapConfig = {
            logging: loggingConfig,
            events: { enabled: eventsEnabled, lifecycle: eventsLifecycle, defaultObservers: eventsDefaultObservers },
            telemetry: telemetryConfig,
            scheduler: schedulerConfig,
        };

        // ── Build runtime handle ───────────────────────────────────────
        const app: ApplicationRuntime<TAppConfig, TEvents> = {
            config: resolvedConfig,
            appConfig: options.appConfig as TAppConfig,
            logger,
            events,
            lifecycleBus,
            db,
            scheduler,
            stop: (reason?: ApplicationStopReason) => performShutdown(state, reason ?? 'manual'),
        };
        state.app = app;

        // ── 6. User start callback ─────────────────────────────────────
        await options.start(app);

        // ── 7. Start scheduler ─────────────────────────────────────────
        if (schedulerConfig.enabled && schedulerConfig.autoStart && scheduler) {
            await scheduler.start();
            state.schedulerStarted = true;
        }

        return app;
    } catch (error) {
        // Reverse-order cleanup of services this bootstrap owns.
        // Scheduler: start() is the last async op before return; if it throws,
        // schedulerStarted is still false, so there is nothing started to stop.
        // DB: injected by the caller (portable bootstrap never creates one), so
        // its lifecycle is caller-owned and not closed here.
        // Telemetry: owned by the bootstrap — shut it down if it was initialized.
        if (state.telemetryInitialized) {
            await shutdownTelemetry();
        }
        throw error;
    }
}

export type { BusLifecycleEvents, EventMap } from '../event-bus/types';
export type { InfraEvents } from '../events';
// Re-export types
export type {
    ApplicationBootstrapConfig,
    ApplicationBootstrapOptions,
    ApplicationConfigLoader,
    ApplicationConfigValidator,
    ApplicationRuntime,
    ApplicationServices,
    ApplicationStopReason,
    ConfigValidationResult,
    DbAdapterLike,
    EventsOptions,
    LoggingOptions,
    SchedulerOptions,
    TelemetryOptions,
} from './types';
