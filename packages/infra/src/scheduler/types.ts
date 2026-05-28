/**
 * Scheduler types and interface.
 */

/** Signature for scheduled action handlers. */
export type ScheduledAction = () => Promise<void>;

/** Abstract scheduler interface — implementations for Node (node-cron) and Cloudflare. */
export interface SchedulerAdapter {
    register(cron: string, action: ScheduledAction): void;
    start(): Promise<void>;
    stop(): Promise<void>;
}
