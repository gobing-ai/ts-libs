/**
 * No-op scheduler adapter for testing and environments without scheduling.
 */
import type { ScheduledAction, SchedulerAdapter } from './types';

export class NoopSchedulerAdapter implements SchedulerAdapter {
    constructor() {}

    register(_cron: string, _action: ScheduledAction): void {
        // noop
    }

    async start(): Promise<void> {
        // noop
    }

    async stop(): Promise<void> {
        // noop
    }
}
