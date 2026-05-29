/**
 * No-op scheduler adapter for testing and environments without scheduling.
 */
import type { ScheduledAction, SchedulerAdapter } from './types.js';

export class NoopSchedulerAdapter implements SchedulerAdapter {
    // biome-ignore lint/complexity/noUselessConstructor: V8 function coverage requires explicit constructor
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
