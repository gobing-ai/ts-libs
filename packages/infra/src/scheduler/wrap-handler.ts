import type { EventBus } from '../event-bus/event-bus';
import type { SchedulerEvents } from '../events';
import { addSpanAttributes, addSpanEvent, traceAsync } from '../telemetry/tracing';
import type { ScheduledAction } from './types';

/**
 * Wrap a scheduled action with OTel tracing, duration measurement, and
 * `scheduler.job.executed` event emission.
 *
 * Composes *on top of* the adapter's inline metrics (executed/failed/duration
 * counters live in the Node/Cloudflare adapters) — this wrapper adds the named
 * tracing span and the lifecycle event, neither of which the adapters provide.
 * Opt-in: wrap an action before registering it when you want that visibility.
 *
 * @param name - Job name, surfaced as `scheduler.job_name` on the span/event.
 * @param action - The action to wrap (new no-arg `ScheduledAction` signature).
 * @param systemBus - Optional bus to emit `scheduler.job.executed` on.
 */
export function wrapScheduledHandler(
    name: string,
    action: ScheduledAction,
    systemBus?: EventBus<SchedulerEvents> | null,
): ScheduledAction {
    return async () => {
        const startTime = performance.now();

        return traceAsync('scheduler.job', async (span) => {
            addSpanAttributes({ 'scheduler.job_name': name });

            let execError: string | undefined;
            try {
                await action();
            } catch (error) {
                execError = error instanceof Error ? error.message : String(error);
                addSpanEvent('scheduler.job.error', { 'scheduler.error': execError });
                span.setStatus({ code: 2, message: execError }); // ERROR
                throw error;
            } finally {
                const durationMs = Math.round(performance.now() - startTime);
                addSpanAttributes({ 'scheduler.duration_ms': durationMs });

                systemBus?.emit('scheduler.job.executed', {
                    name,
                    durationMs,
                    ...(execError !== undefined ? { error: execError } : {}),
                });
            }
        });
    };
}
