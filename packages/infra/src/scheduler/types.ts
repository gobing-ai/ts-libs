/**
 * Scheduler types and interface.
 */

/** Signature for scheduled action handlers. */
export type ScheduledAction = () => Promise<void>;

/**
 * Abstract scheduler interface — implementations for Node and Cloudflare.
 *
 * `stop()` cancels future ticks and drains any currently-executing tick,
 * bounded by an implementation-configured timeout (see ADR-024). A stuck
 * action is abandoned at the deadline rather than blocking shutdown forever.
 */
export interface SchedulerAdapter {
    register(cron: string, action: ScheduledAction): void;
    start(): Promise<void>;
    stop(): Promise<void>;
}
