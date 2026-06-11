/**
 * Built-in service plugins for the application bootstrap.
 *
 * Each factory returns a `Plugin` that maps an existing init/shutdown pair onto
 * the PluginHost lifecycle: `onStart` = init, `onStop` = teardown. Absent
 * hooks are omitted (no-op by absence, not by stub).
 *
 * @module application/plugins
 */

import type { LogLevel } from '../../logger';
import { initializeLogger } from '../../logger';
import { initMetrics, shutdownMetrics } from '../../telemetry/metrics';
import { initTelemetry, shutdownTelemetry } from '../../telemetry/sdk';
import type { ApplicationBootstrapConfig, DbAdapterLike } from '../types';
import type { Plugin } from './types';

// ── Telemetry ──────────────────────────────────────────────────────────────

/**
 * Built-in plugin for telemetry + metrics.
 *
 * `onStart`: `initTelemetry` + `initMetrics` (pre-warm instruments).
 * `onStop`:  `shutdownMetrics` + `shutdownTelemetry` (reverse of init).
 * `failFast: true` — a failing telemetry init aborts the bootstrap.
 */
export function telemetryPlugin(config: ApplicationBootstrapConfig['telemetry']): Plugin {
    return {
        name: 'builtin:telemetry',
        version: '0.0.0',
        failFast: true,
        onLoad: async () => {},
        onStart: async () => {
            // Always record the resolved config — `enabled: false` must reach the
            // master switch so infra spans/instruments actually go quiet.
            initTelemetry({
                enabled: config.enabled,
                serviceName: config.serviceName,
                environment: config.environment,
                dbStatementDebug: config.dbStatementDebug,
            });
            if (config.enabled) {
                initMetrics();
            }
        },
        onStop: async () => {
            if (config.enabled) {
                shutdownMetrics();
            }
            await shutdownTelemetry();
        },
    };
}

// ── Logger ─────────────────────────────────────────────────────────────────

/**
 * Built-in plugin for the structured logger.
 *
 * `onStart`: `initializeLogger` (skipped when an injected logger is present).
 * No `onStop` — the logger has no teardown.
 * `failFast: true` — a failing logger init aborts the bootstrap.
 */
export function loggerPlugin(
    config: {
        enabled: boolean;
        level: LogLevel;
        console: boolean;
        json: boolean;
        fileSink?: ((line: string) => void) | undefined;
    },
    injected?: boolean,
): Plugin {
    return {
        name: 'builtin:logger',
        version: '0.0.0',
        failFast: true,
        onLoad: async () => {},
        onStart: async () => {
            if (config.enabled && !injected) {
                await initializeLogger({
                    level: config.level,
                    console: config.console,
                    json: config.json,
                    fileSink: config.fileSink,
                });
            }
        },
    };
}

// ── User callback ──────────────────────────────────────────────────────────

import type { EventMap } from '../../event-bus/types';
import type { ApplicationRuntime } from '../types';

/**
 * Built-in plugin that wraps the user's `start`/`stop` callbacks.
 *
 * `onStart`: calls `options.start(app)`. `failFast: true`.
 * `onStop`:  calls `options.stop(app, reason)`. Registered after services,
 *            before scheduler, so stopAll/reverse-order places it after
 *            scheduler.stop and before service teardown.
 */
export function userCallbackPlugin<TAppConfig, TEvents extends EventMap>(
    start: (app: ApplicationRuntime<TAppConfig, TEvents>) => Promise<void> | void,
    stop: ((app: ApplicationRuntime<TAppConfig, TEvents>, reason: string) => Promise<void> | void) | undefined,
    app?: ApplicationRuntime<TAppConfig, TEvents>,
): Plugin {
    return {
        name: 'builtin:user-callback',
        version: '0.0.0',
        failFast: true,
        onLoad: async () => {},
        onStart: async () => {
            if (app) await start(app);
        },
        onStop:
            stop && app
                ? async (_host, reason) => {
                      await stop(app, reason ?? 'manual');
                  }
                : undefined,
    };
}

// ── Scheduler ──────────────────────────────────────────────────────────────
import type { SchedulerAdapter } from '../../scheduler/types';

/**
 * Built-in plugin for the scheduler.
 *
 * `onStart`: `adapter.start()` when `autoStart` is true.
 * `onStop`:  `adapter.stop()` — fail-soft.
 *
 * Registered LAST so autoStart always runs after the user callback.
 */
export function schedulerPlugin(adapter: SchedulerAdapter, autoStart: boolean): Plugin {
    return {
        name: 'builtin:scheduler',
        version: '0.0.0',
        failFast: true,
        onLoad: async () => {},
        onStart: async () => {
            if (autoStart) {
                await adapter.start();
            }
        },
        onStop: async () => {
            // Fail-soft — the host always catches stop/unload errors
            await adapter.stop();
        },
    };
}

// ── DB (reason-aware, for owned adapters only) ────────────────────────────

/**
 * Built-in plugin for a DB adapter the bootstrap OWNS.
 *
 * `onStop(reason)`: `db.close()` — best-effort.
 * Register ONLY when the bootstrap creates the adapter (Node subpath).
 * Do NOT register for caller-injected `services.db` — those are caller-owned.
 */
export function dbPlugin(db: DbAdapterLike): Plugin {
    return {
        name: 'builtin:db',
        version: '0.0.0',
        failFast: false,
        onLoad: async () => {},
        onStart: async () => {},
        onStop: async () => {
            try {
                db.close();
            } catch {
                /* best-effort */
            }
        },
    };
}
