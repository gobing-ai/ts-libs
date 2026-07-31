/**
 * Cloudflare Workers scheduler adapter using Cron Triggers.
 * Uses minimal local type declarations — no @cloudflare/workers-types dependency.
 */
import {
    getSchedulerJobDuration,
    getSchedulerJobExecutedTotal,
    getSchedulerJobFailedTotal,
} from '../telemetry/metrics';
import type { ScheduledAction, SchedulerAdapter } from './types';

interface CfScheduledEvent {
    cron: string;
    scheduledTime: number;
    waitUntil(promise: Promise<unknown>): void;
}

interface CfEventContext {
    waitUntil(promise: Promise<unknown>): void;
}

/**
 * Scheduler adapter for Cloudflare Workers Cron Triggers.
 *
 * Register cron→action pairs, then call {@link CloudflareSchedulerAdapter.handleScheduledEvent}
 * from the Worker's `scheduled()` export.
 */
export class CloudflareSchedulerAdapter implements SchedulerAdapter {
    private readonly entries = new Map<string, ScheduledAction>();

    constructor() {}

    register(cron: string, action: ScheduledAction): void {
        this.entries.set(cron, action);
    }

    async start(): Promise<void> {
        // Cloudflare Workers use cron triggers defined in wrangler.toml.
        // The `scheduled()` handler should call `handleScheduledEvent()`.
    }

    /**
     * No-op drain. Cloudflare Workers fire Cron Triggers externally — this adapter
     * owns no timer to cancel — and `handleScheduledEvent` already bounds each
     * in-flight action via `ctx.waitUntil()`, the runtime's own drain. So there is
     * nothing for stop() to await here; clearing registrations is the full contract
     * (ADR-024).
     */
    async stop(): Promise<void> {
        this.entries.clear();
    }

    /**
     * Handle a Cloudflare Workers Cron Trigger event.
     * Call this from the Worker's `scheduled()` export.
     */
    handleScheduledEvent(event: CfScheduledEvent, ctx: CfEventContext): void {
        const action = this.entries.get(event.cron);
        if (action) {
            const startMs = performance.now();
            getSchedulerJobExecutedTotal().add(1, { cron: event.cron });
            ctx.waitUntil(
                action()
                    .catch((error: unknown) => {
                        getSchedulerJobFailedTotal().add(1, { cron: event.cron });
                        throw error;
                    })
                    .finally(() => {
                        // Duration parity with NodeSchedulerAdapter — record the job
                        // duration metric keyed by cron for both runtimes.
                        getSchedulerJobDuration().record(performance.now() - startMs, { cron: event.cron });
                    }),
            );
        }
    }
}
