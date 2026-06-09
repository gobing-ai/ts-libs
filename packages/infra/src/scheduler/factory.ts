/**
 * Scheduler factory — initializes an adapter and registers cron entries.
 *
 * The adapter is passed in explicitly (dependency injection); there is no
 * process-global adapter state. Callers that don't supply one get a
 * {@link NoopSchedulerAdapter}.
 */
import { NoopSchedulerAdapter } from './noop';
import type { ScheduledAction, SchedulerAdapter } from './types';

/**
 * Initialize the scheduler adapter and register cron entries.
 *
 * MUST be called before `adapter.start()`. If the adapter is already
 * running, newly registered entries will NOT be started until the next
 * `start()` call.
 *
 * @param adapter - Adapter to use. Defaults to a {@link NoopSchedulerAdapter}.
 * @param cronEntries - `[cron, action]` pairs to register on the adapter.
 * @returns The configured adapter.
 */
export function initScheduler(
    adapter?: SchedulerAdapter,
    cronEntries?: Array<[string, ScheduledAction]>,
): SchedulerAdapter {
    const resolved = adapter ?? new NoopSchedulerAdapter();

    if (cronEntries) {
        for (const [cron, action] of cronEntries) {
            resolved.register(cron, action);
        }
    }

    return resolved;
}
