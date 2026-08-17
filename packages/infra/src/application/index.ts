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
import { attachFileObserver } from '../event-bus/file-observer';
import type { BusLifecycleEvents, EventMap } from '../event-bus/types';
import type { InfraEvents } from '../events';
import { getLogger, type Logger } from '../logger';
import { initScheduler } from '../scheduler/factory';
import type { SchedulerAdapter } from '../scheduler/types';
import { loggerPlugin, schedulerPlugin, telemetryPlugin, userCallbackPlugin } from './plugins/builtins';
import { PluginHost } from './plugins/host';
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
    pluginHost: PluginHost;
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

    // 1. Stop + unload plugins in reverse registration order (fail-soft).
    //    Scheduler stop and telemetry shutdown run here via their onStop hooks.
    await state.pluginHost.stopAll(reason);
    await state.pluginHost.unloadAll(reason);
    // Shutdown is complete — the host's stopAll/unloadAll calls every plugin's
    // onStop/onUnload in reverse registration order, including user callback,
    // scheduler, and service teardown. No inline steps.
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Portable application bootstrap.
 *
 * Orchestrates logger, telemetry, events, optional DB, and optional scheduler.
 * Accepts injected dependencies; never opens files, reads config from disk,
 * or wires runtime-specific exporters.
 *
 * The returned `lifecycleBus` is the parent of the application `events` bus and
 * can be passed to RuleEngine, WorkflowService, AiRunner, TeamOrchestrator, and
 * APIClient so their domain events share one System Events stream. A supplied
 * file-observer writer records that stream as JSONL; the Node subpath supplies
 * the writer and default `.spur/logs/system-events.jsonl` path.
 *
 * Startup is plugin-driven. Built-in service plugins are registered in dependency
 * order, then `loadAll()` + `startAll()` run them forward:
 * 1. Resolve bootstrap config; build EventBus + PluginHost
 * 2. Register built-ins in order: logger → telemetry → [caller plugins] →
 *    user-callback → scheduler (scheduler last so autoStart runs after user start)
 * 3. `loadAll()` then `startAll()` — `failFast` plugins abort boot on failure
 *
 * Shutdown is the reverse fan-out: `stopAll(reason)` → `unloadAll(reason)` calls
 * every plugin's `onStop`/`onUnload` in reverse registration order (scheduler stop,
 * user `stop(app, reason)`, telemetry shutdown, owned-DB close). Caller-injected
 * `services.db` is caller-owned and never closed here.
 *
 * If startup fails, the host's reverse-order `stopAll('error')`/`unloadAll('error')`
 * tears down whatever started before rethrowing. `stop()` is idempotent.
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
    const eventsFileObserver = options.config?.events?.fileObserver ?? true;
    const fileObserverWriter = options.services?.fileObserverWriter;
    const eventsFilePath =
        options.config?.events?.filePath ??
        (fileObserverWriter !== undefined ? '.spur/logs/system-events.jsonl' : undefined);

    const state: RuntimeState<TAppConfig, TEvents> = {
        app: undefined,
        stopped: false,
        pluginHost: undefined as unknown as PluginHost,
    };

    try {
        // ── 1. Resolve logger (init deferred to loggerPlugin) ───────────
        const logger: Logger = options.services?.logger ?? getLogger('bootstrap');
        const loggerInjected = !!options.services?.logger;

        // ── 3. Create lifecycle bus + EventBus ─────────────────────────
        const lifecycleBus =
            eventsEnabled && eventsLifecycle ? (options.services?.lifecycleBus ?? createLifecycleBus()) : undefined;

        if (lifecycleBus && eventsDefaultObservers) {
            attachDefaultObservers(lifecycleBus);
        }

        // Attach the JSONL file observer when a writer is available. The
        // portable subpath never opens files (ADR-011): the Node subpath
        // injects `createNodeFileSystem()` (or a test stub) and resolves the
        // default path against the project root. Without a writer or path
        // the observer is a no-op even if `events.fileObserver` is `true`.
        let fileObserverAttached = false;
        let fileObserverPath: string | undefined;
        if (lifecycleBus && eventsFileObserver && eventsFilePath !== undefined && fileObserverWriter !== undefined) {
            attachFileObserver(lifecycleBus, eventsFilePath, fileObserverWriter);
            fileObserverAttached = true;
            fileObserverPath = eventsFilePath;
        }

        const events =
            options.services?.events ??
            options.config?.events?.bus ??
            new EventBus<TEvents>({ lifecycleBus: lifecycleBus as EventBus<BusLifecycleEvents> | undefined });

        // ── 4. Database (injected only) ────────────────────────────────
        const db: DbAdapterLike | undefined = options.services?.db;

        // ── 5. Scheduler ───────────────────────────────────────────────
        let scheduler: SchedulerAdapter | undefined;
        if (schedulerConfig.enabled) {
            const adapter = options.services?.scheduler ?? schedOpts?.adapter;
            scheduler = initScheduler(adapter, schedOpts?.entries);
        }

        // ── 5.5 Plugin host + built-in service plugins ─────────────────
        const pluginHost: PluginHost =
            options.services?.pluginHost ?? new PluginHost(events as unknown as EventBus<EventMap>);
        state.pluginHost = pluginHost;

        // Register built-in service plugins in dependency order: logger -> telemetry.
        pluginHost.register(loggerPlugin(loggingConfig, loggerInjected));
        pluginHost.register(telemetryPlugin(telemetryConfig));
        // Caller-injected `services.db` is NOT closed by the portable layer — it is
        // caller-owned (task 0028). Only adapters the bootstrap CREATES (the Node
        // subpath) are wrapped in a `dbPlugin` whose onStop closes them.

        // ── Build runtime handle (before startAll so plugins can capture it) ─
        const resolvedConfig: ApplicationBootstrapConfig = {
            logging: loggingConfig,
            events: {
                enabled: eventsEnabled,
                lifecycle: eventsLifecycle,
                defaultObservers: eventsDefaultObservers,
                fileObserver: fileObserverAttached,
                ...(fileObserverPath !== undefined ? { filePath: fileObserverPath } : {}),
            },
            telemetry: telemetryConfig,
            scheduler: schedulerConfig,
        };

        const app: ApplicationRuntime<TAppConfig, TEvents> = {
            config: resolvedConfig,
            appConfig: options.appConfig as TAppConfig,
            logger,
            events,
            lifecycleBus,
            db,
            scheduler,
            pluginHost,
            stop: (reason?: ApplicationStopReason) => performShutdown(state, reason ?? 'manual'),
        };
        state.app = app;

        // ── Register caller-provided plugins (before user callback) ─────────
        if (options.plugins) {
            for (const p of options.plugins) {
                pluginHost.register(p);
            }
        }

        // ── Register user-callback plugin (after services, before scheduler) ─
        pluginHost.register(
            userCallbackPlugin(
                options.start,
                options.stop as ((app: ApplicationRuntime<TAppConfig, TEvents>, reason: string) => void) | undefined,
                app,
            ),
        );

        // ── Register scheduler plugin (LAST — autoStart after user callback) ─
        if (schedulerConfig.enabled && scheduler) {
            pluginHost.register(schedulerPlugin(scheduler, schedulerConfig.autoStart));
        }

        // ── Load + start (built-in failFast=rethrow on critical failure) ─
        await pluginHost.loadAll();
        await pluginHost.startAll();
        return app;
    } catch (error) {
        // Startup failed: tear down whatever started, in reverse registration
        // order, via the host. Each plugin's onStop/onUnload is best-effort, so a
        // partially-started ring still releases its resources (telemetry, scheduler,
        // owned DB). Caller-injected services.db is caller-owned and not touched.
        await state.pluginHost.stopAll('error');
        await state.pluginHost.unloadAll('error');
        throw error;
    }
}

export type { BusLifecycleEvents, EventMap } from '../event-bus/types';
export type { InfraEvents } from '../events';
export type { PluginHost } from './plugins/host';
export type { Plugin, PluginSummary } from './plugins/types';
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
