/**
 * Default lifecycle observers for EventBus self-observability.
 *
 * Connect `BusLifecycleEvents` to the logging and telemetry infrastructure so
 * operators get visibility without wiring everything by hand. Opt-in: nothing
 * is attached unless you call one of these.
 *
 * **Metrics are intentionally omitted here.** Unlike the original design, the
 * `EventBus` core now increments `eventbus.emits.total` / `eventbus.errors.total`
 * inline on every emit (see `event-bus.ts`). A metrics observer would
 * double-count, so the restored default set is **log + telemetry-trace only**.
 *
 * @example One-liner setup
 * ```ts
 * import { EventBus, createLifecycleBus, attachDefaultObservers } from '@gobing-ai/ts-infra';
 *
 * const lifecycleBus = createLifecycleBus();
 * attachDefaultObservers(lifecycleBus);
 *
 * const appBus = new EventBus<AppEvents>({ lifecycleBus });
 * ```
 */

import { getLogger, type Logger } from '../logger';
import { addSpanAttributes, addSpanEvent, traceAsync } from '../telemetry/tracing';
import { EventBus } from './event-bus';
import type { BusLifecycleEvents } from './types';

let _obsLogger: Logger | undefined;
function obsLogger(): Logger {
    if (!_obsLogger) _obsLogger = getLogger('event-bus.observers');
    return _obsLogger;
}

/**
 * Create a dedicated `EventBus<BusLifecycleEvents>` for use as the
 * `lifecycleBus` constructor argument on another `EventBus`.
 */
export function createLifecycleBus(): EventBus<BusLifecycleEvents> {
    return new EventBus<BusLifecycleEvents>();
}

/**
 * Register handlers that write structured log entries for every lifecycle event.
 *
 * - `bus.emit.done`   → debug (warn if errors > 0)
 * - `bus.emit.noop`   → debug
 * - `bus.handler.error` → warn
 * - `bus.handler.async.enqueued` → debug
 */
export function attachLogObserver(lifecycleBus: EventBus<BusLifecycleEvents>): void {
    lifecycleBus.on('bus.emit.done', (detail) => {
        if (detail.errors > 0) {
            obsLogger().warn('emit completed with errors', { ...detail });
        } else {
            obsLogger().debug('emit done', { ...detail });
        }
    });

    lifecycleBus.on('bus.emit.noop', (detail) => {
        obsLogger().debug('emit with zero handlers', { ...detail });
    });

    lifecycleBus.on('bus.handler.error', (detail) => {
        obsLogger().warn('handler error', { ...detail });
    });

    lifecycleBus.on('bus.handler.async.enqueued', (detail) => {
        obsLogger().debug('async job enqueued', { ...detail });
    });
}

/**
 * Register handlers that create OpenTelemetry spans for emit operations.
 *
 * Each `bus.emit.done` creates a span named `eventbus.emit.{EVENT}` with
 * attributes for sync/async counts, duration, and error count. Degrades
 * gracefully when telemetry is not initialised (`traceAsync` is a pass-through).
 */
export function attachTelemetryObserver(lifecycleBus: EventBus<BusLifecycleEvents>): void {
    lifecycleBus.on('bus.emit.done', (detail) => {
        void traceAsync(`eventbus.emit.${detail.event}`, async (_span) => {
            addSpanAttributes({
                'eventbus.event': detail.event,
                'eventbus.sync_count': detail.syncCount,
                'eventbus.async_count': detail.asyncCount,
                'eventbus.duration_ms': detail.emitDurationMs,
                'eventbus.errors': detail.errors,
            });

            if (detail.errors > 0) {
                addSpanEvent('eventbus.emit.errors', { 'eventbus.error_count': detail.errors });
            }
        });
    });

    lifecycleBus.on('bus.handler.error', (detail) => {
        void traceAsync('eventbus.handler.error', async (span) => {
            addSpanAttributes({
                'eventbus.event': detail.event,
                'eventbus.handler_mode': detail.mode,
                'eventbus.error': detail.error,
            });
            span.setStatus({ code: 2, message: detail.error }); // ERROR
        });
    });
}

/**
 * Attach the built-in observers (log + telemetry) to the lifecycle bus in one
 * call. Recommended default for production deployments. Metrics are emitted by
 * the `EventBus` core inline, so they are not part of this set.
 */
export function attachDefaultObservers(lifecycleBus: EventBus<BusLifecycleEvents>): void {
    attachLogObserver(lifecycleBus);
    attachTelemetryObserver(lifecycleBus);
}
