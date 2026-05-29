/**
 * Cloudflare Workers scheduler adapter using Cron Triggers.
 * Uses minimal local type declarations — no @cloudflare/workers-types dependency.
 */
import type { ScheduledAction, SchedulerAdapter } from './types.js';

interface CfScheduledEvent {
    cron: string;
    scheduledTime: number;
    waitUntil(promise: Promise<unknown>): void;
}

interface CfEventContext {
    waitUntil(promise: Promise<unknown>): void;
}

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
            ctx.waitUntil(action());
        }
    }
}
