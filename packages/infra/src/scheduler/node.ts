/**
 * Node.js scheduler adapter using a simple setInterval-based approach.
 * No external cron library dependency — cron expressions are parsed minimally.
 */

import { settleWithin } from '../internals/drain';
import { getLogger } from '../logger';
import {
    getSchedulerJobDuration,
    getSchedulerJobExecutedTotal,
    getSchedulerJobFailedTotal,
} from '../telemetry/metrics';
import type { ScheduledAction, SchedulerAdapter } from './types';

/** Simple helper to parse cron-like interval strings into milliseconds. */
function parseInterval(cron: string): number {
    // Support simple patterns: "* * * * *" (every minute), "*/5 * * * *" (every 5 min)
    // Also support direct ms strings like "60000"
    const trimmed = cron.trim();
    const num = Number(trimmed);
    if (trimmed !== '' && !Number.isNaN(num)) {
        // Guard against 0/negative intervals — setInterval would spin hot.
        if (num > 0) return num;
    } else {
        const parts = trimmed.split(/\s+/);
        if (parts.length === 5 && parts[0] === '*') {
            return 60_000; // every minute
        }

        // */N pattern
        const match = parts[0]?.match(/^\*\/(\d+)$/);
        if (match && Number(match[1]) > 0) {
            return Number(match[1]) * 60_000;
        }
    }

    // Real cron field expressions ("0 3 * * *") are NOT supported — running
    // them every minute silently would badly misfire, so warn on fallback.
    getLogger('scheduler.node').warn('Unsupported cron expression — falling back to a 60s interval', { cron });
    return 60_000;
}

interface ScheduledEntry {
    cron: string;
    action: ScheduledAction;
    timer?: ReturnType<typeof setInterval>;
}

/** Constructor options for {@link NodeSchedulerAdapter}. */
export interface NodeSchedulerAdapterConfig {
    /**
     * Upper bound (ms) on how long `stop()` waits for an in-flight tick to settle.
     * A hung action is abandoned at this deadline so it cannot block shutdown.
     * Defaults to 30000 (matching `DBQueueConsumer`).
     */
    readonly drainTimeoutMs?: number;
}

/**
 * Scheduler adapter for Node.js using a setInterval-based approach.
 * No external cron library dependency — cron expressions are parsed minimally.
 *
 * `stop()` drains in-flight ticks, bounded by `drainTimeoutMs` (ADR-024): an
 * action already running when `stop()` is called is awaited rather than torn
 * down, which would leave a half-written row or a half-flushed batch.
 */
export class NodeSchedulerAdapter implements SchedulerAdapter {
    private readonly entries: ScheduledEntry[] = [];
    private readonly drainTimeoutMs: number;
    private running = false;
    private readonly inflight = new Set<Promise<void>>();

    constructor(config: NodeSchedulerAdapterConfig = {}) {
        const { drainTimeoutMs } = config;
        if (drainTimeoutMs !== undefined && (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs < 0)) {
            throw new RangeError(
                `NodeSchedulerAdapter drainTimeoutMs must be a non-negative finite number; received ${drainTimeoutMs}`,
            );
        }
        this.drainTimeoutMs = drainTimeoutMs ?? 30_000;
    }

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

        // Drain in-flight ticks, bounded by a shared absolute deadline. clearInterval
        // cancels future ticks but not one already executing; without this wait a tick
        // mid-action when stop() is called would keep running after stop() resolves,
        // tearing down a half-written row or half-flushed batch (ADR-024).
        const deadline = Date.now() + this.drainTimeoutMs;
        for (const p of [...this.inflight]) {
            await settleWithin(p, deadline);
        }
    }

    private startEntry(entry: ScheduledEntry): void {
        if (entry.timer) return;

        const interval = parseInterval(entry.cron);
        // setInterval discards the async handler's returned promise, so capture it
        // here for stop() to drain. _onScheduledTick never rejects (try/catch),
        // so the cleanup runs on both paths with no unhandled-rejection risk.
        entry.timer = setInterval(() => {
            const tick = this._onScheduledTick(entry);
            this.inflight.add(tick);
            const cleanup = (): void => {
                this.inflight.delete(tick);
            };
            tick.then(cleanup, cleanup);
        }, interval);
    }

    private async _onScheduledTick(entry: ScheduledEntry): Promise<void> {
        const startMs = performance.now();
        getSchedulerJobExecutedTotal().add(1, { cron: entry.cron });
        try {
            await entry.action();
        } catch {
            // Swallow — scheduler errors should not crash the process
            getSchedulerJobFailedTotal().add(1, { cron: entry.cron });
        } finally {
            getSchedulerJobDuration().record(performance.now() - startMs, { cron: entry.cron });
        }
    }
}
