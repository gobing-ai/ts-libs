/**
 * Scheduler factory — selects adapter based on runtime.
 */
import type { ScheduledAction, SchedulerAdapter } from './types.js';

let runtimeAdapter: SchedulerAdapter | undefined;

export function setSchedulerAdapter(adapter: SchedulerAdapter): void {
    runtimeAdapter = adapter;
}

export function getSchedulerAdapter(): SchedulerAdapter | undefined {
    return runtimeAdapter;
}

export function initScheduler(cronEntries?: Array<[string, ScheduledAction]>): SchedulerAdapter {
    // Default: create a noop adapter. Apps inject their own via setSchedulerAdapter.
    if (!runtimeAdapter) {
        runtimeAdapter = createNoopScheduler();
    }

    if (cronEntries) {
        for (const [cron, action] of cronEntries) {
            runtimeAdapter.register(cron, action);
        }
    }

    return runtimeAdapter;
}

function createNoopScheduler(): SchedulerAdapter {
    return {
        register(): void {
            /* noop */
        },
        start(): Promise<void> {
            return Promise.resolve();
        },
        stop(): Promise<void> {
            return Promise.resolve();
        },
    };
}
