/**
 * Scheduler factory — selects adapter based on runtime.
 */
import { NoopSchedulerAdapter } from './noop';
import type { ScheduledAction, SchedulerAdapter } from './types';

let runtimeAdapter: SchedulerAdapter | undefined;

/** Set the runtime scheduler adapter. Call before {@link initScheduler}. */
export function setSchedulerAdapter(adapter: SchedulerAdapter): void {
    runtimeAdapter = adapter;
}

/** Reset the scheduler adapter singleton. For testing. */
export function resetSchedulerAdapter(): void {
    runtimeAdapter = undefined;
}

/** Get the currently configured scheduler adapter, or `undefined` if not set. */
export function getSchedulerAdapter(): SchedulerAdapter | undefined {
    return runtimeAdapter;
}

/**
 * Initialize the scheduler adapter and register cron entries.
 *
 * MUST be called before `adapter.start()`. If the adapter is already
 * running, newly registered entries will NOT be started until the next
 * `start()` call.
 *
 * Returns the configured adapter (defaults to noop if none set).
 */
export function initScheduler(cronEntries?: Array<[string, ScheduledAction]>): SchedulerAdapter {
    // Default: create a noop adapter. Apps inject their own via setSchedulerAdapter.
    if (!runtimeAdapter) {
        runtimeAdapter = new NoopSchedulerAdapter();
    }

    if (cronEntries) {
        for (const [cron, action] of cronEntries) {
            runtimeAdapter.register(cron, action);
        }
    }

    return runtimeAdapter;
}
