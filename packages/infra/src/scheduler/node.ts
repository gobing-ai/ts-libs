/**
 * Node.js scheduler adapter using a simple setInterval-based approach.
 * No external cron library dependency — cron expressions are parsed minimally.
 */
import type { ScheduledAction, SchedulerAdapter } from './types.js';

/** Simple helper to parse cron-like interval strings into milliseconds. */
function parseInterval(cron: string): number {
    // Support simple patterns: "* * * * *" (every minute), "*/5 * * * *" (every 5 min)
    // Also support direct ms strings like "60000"
    const num = Number(cron);
    if (!Number.isNaN(num)) return num;

    const parts = cron.trim().split(/\s+/);
    if (parts.length === 5 && parts[0] === '*') {
        return 60_000; // every minute default
    }

    // */N pattern
    const match = parts[0]?.match(/^\*\/(\d+)$/);
    if (match) {
        return Number(match[1]) * 60_000;
    }

    return 60_000; // fallback: every minute
}

interface ScheduledEntry {
    cron: string;
    action: ScheduledAction;
    timer?: ReturnType<typeof setInterval>;
}

export class NodeSchedulerAdapter implements SchedulerAdapter {
    private readonly entries: ScheduledEntry[] = [];
    private running = false;

    constructor() {}

    register(cron: string, action: ScheduledAction): void {
        this.entries.push({ cron, action });
        if (this.running) {
            const last = this.entries[this.entries.length - 1];
            if (last) {
                this.startEntry(last);
            }
        }
    }

    async start(): Promise<void> {
        if (this.running) return;

        this.running = true;
        for (const entry of this.entries) {
            this.startEntry(entry);
        }
    }

    async stop(): Promise<void> {
        this.running = false;
        for (const entry of this.entries) {
            if (entry.timer) {
                clearInterval(entry.timer);
                entry.timer = undefined;
            }
        }
    }

    private startEntry(entry: ScheduledEntry): void {
        if (entry.timer) return;

        const interval = parseInterval(entry.cron);
        entry.timer = setInterval(this._onScheduledTick.bind(this, entry), interval);
    }

    private async _onScheduledTick(entry: ScheduledEntry): Promise<void> {
        try {
            await entry.action();
        } catch {
            // Swallow — scheduler errors should not crash the process
        }
    }
}
