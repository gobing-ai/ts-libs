/**
 * Node.js scheduler adapter — interval-based for the three legacy cadence
 * forms, self-rescheduling setTimeout for real five-field cron (task 0734).
 *
 * No external cron library dependency — cron expressions are parsed by the
 * internal `scheduler/cron.ts` grammar shared with `application-node.ts`.
 */

import { settleWithin } from '../internals/drain';
import {
    getSchedulerJobDuration,
    getSchedulerJobExecutedTotal,
    getSchedulerJobFailedTotal,
} from '../telemetry/metrics';
import { type CronExpression, nextCronTime, parseCronExpression } from './cron';
import type { ScheduledAction, SchedulerAdapter } from './types';

/** Platform timer maximum for `setTimeout` (2^31 - 1 ms). Longer delays are chunked. */
const MAX_TIMEOUT = 2_147_483_647;

/**
 * Parse the three legacy interval cadences, returning milliseconds, or
 * `undefined` when the string is real cron (or invalid) and must route to the
 * cron grammar instead.
 *
 * Legacy forms preserved verbatim (task 0734 R2): a positive millisecond
 * number, `* * * * *` (60s), and the step-N wildcard form (N*60s) — all
 * measured from adapter start as setInterval cadences.
 */
function parseInterval(cron: string): number | undefined {
    const trimmed = cron.trim();
    const num = Number(trimmed);
    if (trimmed !== '' && !Number.isNaN(num)) {
        // Guard against 0/negative intervals — setInterval would spin hot.
        return num > 0 ? num : undefined;
    }

    const parts = trimmed.split(/\s+/);
    // Only the documented 5-field forms are every-N-minutes: "* * * * *" and
    // "*/N * * * *". A first-field wildcard alone ("* 3 * * *") is real cron
    // and must not silently fire every 60s (task 0060 F7).
    const restWild = parts.length === 5 && parts[1] === '*' && parts[2] === '*' && parts[3] === '*' && parts[4] === '*';
    if (restWild && parts[0] === '*') {
        return 60_000;
    }

    const nField = restWild ? parts[0] : parts.length === 1 ? parts[0] : undefined;
    const match = nField?.match(/^\*\/(\d+)$/);
    if (match && Number(match[1]) > 0) {
        return Number(match[1]) * 60_000;
    }

    return undefined;
}

/** A registered entry: an interval cadence or a self-rescheduling cron tick. */
type ScheduledEntry =
    | {
          kind: 'interval';
          cron: string;
          action: ScheduledAction;
          intervalMs: number;
          timer?: ReturnType<typeof setInterval>;
      }
    | {
          kind: 'cron';
          cron: string;
          action: ScheduledAction;
          expr: CronExpression;
          target: number;
          timer?: ReturnType<typeof setTimeout>;
      };

/** Constructor options for {@link NodeSchedulerAdapter}. */
export interface NodeSchedulerAdapterConfig {
    /**
     * Upper bound (ms) on how long `stop()` waits for an in-flight tick to settle.
     * A hung action is abandoned at this deadline so it cannot block shutdown.
     * Defaults to 30000 (matching `DBQueueConsumer`).
     */
    readonly drainTimeoutMs?: number;
    /**
     * Deterministic clock seam (task 0734 R2). Returns epoch milliseconds;
     * defaults to `Date.now`. Used for cron target computation and re-checks.
     */
    readonly now?: () => number;
}

/**
 * Scheduler adapter for Node.js. Interval entries use `setInterval`; real cron
 * entries self-reschedule with `setTimeout` so ticks never overlap and
 * occurrences missed while a tick runs are skipped (task 0734 R2).
 *
 * `stop()` drains in-flight ticks, bounded by `drainTimeoutMs` (ADR-024): an
 * action already running when `stop()` is called is awaited rather than torn
 * down, which would leave a half-written row or a half-flushed batch.
 */
export class NodeSchedulerAdapter implements SchedulerAdapter {
    private readonly entries: ScheduledEntry[] = [];
    private readonly drainTimeoutMs: number;
    private readonly now: () => number;
    private running = false;
    private readonly inflight = new Set<Promise<void>>();

    constructor(config: NodeSchedulerAdapterConfig = {}) {
        const { drainTimeoutMs, now } = config;
        if (drainTimeoutMs !== undefined && (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs < 0)) {
            throw new RangeError(
                `NodeSchedulerAdapter drainTimeoutMs must be a non-negative finite number; received ${drainTimeoutMs}`,
            );
        }
        this.drainTimeoutMs = drainTimeoutMs ?? 30_000;
        this.now = now ?? (() => Date.now());
    }

    register(cron: string, action: ScheduledAction): void {
        // Fail at registration time: an unsupported expression must never reach
        // start(), where it would otherwise create a silently-wrong interval
        // (task 0060 F7) or a never-firing cron (task 0734 R1).
        const entry = this.parseEntry(cron, action);
        this.entries.push(entry);
        if (this.running) {
            this.startEntry(entry);
        }
    }

    private parseEntry(cron: string, action: ScheduledAction): ScheduledEntry {
        const intervalMs = parseInterval(cron);
        if (intervalMs !== undefined) {
            return { kind: 'interval', cron, action, intervalMs };
        }
        // Real five-field cron. Validate and verify a next occurrence exists at
        // registration (bounded scan) so an unsatisfiable expression fails here.
        const expr = parseCronExpression(cron);
        const target = nextCronTime(expr, this.now()).getTime();
        return { kind: 'cron', cron, action, expr, target };
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
            if (entry.timer !== undefined) {
                if (entry.kind === 'interval') {
                    clearInterval(entry.timer);
                } else {
                    clearTimeout(entry.timer);
                }
                entry.timer = undefined;
            }
        }

        // Drain in-flight ticks, bounded by a shared absolute deadline. Clearing
        // timers cancels future ticks but not one already executing; without this
        // wait a tick mid-action when stop() is called would keep running after
        // stop() resolves, tearing down a half-written row or half-flushed batch
        // (ADR-024).
        const deadline = Date.now() + this.drainTimeoutMs;
        for (const p of [...this.inflight]) {
            await settleWithin(p, deadline);
        }
    }

    private startEntry(entry: ScheduledEntry): void {
        if (entry.timer !== undefined) return;

        if (entry.kind === 'interval') {
            entry.timer = setInterval(() => {
                const tick = this._onScheduledTick(entry);
                this.inflight.add(tick);
                const cleanup = (): void => {
                    this.inflight.delete(tick);
                };
                tick.then(cleanup, cleanup);
            }, entry.intervalMs);
        } else {
            this.armCron(entry);
        }
    }

    /**
     * Arm the cron entry's next `setTimeout`, chunking any delay beyond the
     * platform timer maximum. On a chunk wake the wall clock is re-checked
     * before firing, so an injected/real clock shift never fires early.
     */
    private armCron(entry: Extract<ScheduledEntry, { kind: 'cron' }>): void {
        if (!this.running) return;

        let delay = entry.target - this.now();
        if (delay <= 0) {
            // Target already passed (clock shift): recompute strictly after now.
            entry.target = nextCronTime(entry.expr, this.now()).getTime();
            delay = entry.target - this.now();
        }

        if (delay > MAX_TIMEOUT) {
            // Delay exceeds the platform maximum — arm a safe chunk; on wake,
            // re-check now() before firing.
            entry.timer = setTimeout(() => {
                this.armCron(entry);
            }, MAX_TIMEOUT);
            return;
        }

        entry.timer = setTimeout(() => {
            void this.fireCron(entry);
        }, delay);
    }

    /**
     * Fire a cron tick: re-check the wall clock against the target, run the
     * action once, then recompute the next occurrence strictly from `now()` and
     * re-arm only while still running. Ticks never overlap and occurrences
     * missed while a tick runs are skipped (task 0734 R2).
     */
    private async fireCron(entry: Extract<ScheduledEntry, { kind: 'cron' }>): Promise<void> {
        entry.timer = undefined;

        if (this.now() < entry.target) {
            // Not actually time yet (early chunk wake / clock shift) — re-arm.
            this.armCron(entry);
            return;
        }

        const tick = this._onScheduledTick(entry);
        this.inflight.add(tick);
        const cleanup = (): void => {
            this.inflight.delete(tick);
        };
        await tick.then(cleanup, cleanup);

        if (this.running) {
            entry.target = nextCronTime(entry.expr, this.now()).getTime();
            this.armCron(entry);
        }
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
