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

/**
 * A declarative scheduler job (task 0734). Exactly one of `intervalMinutes` or
 * `cron` is present — the schedule XOR is enforced by the Node subpath's
 * `normalizeSchedulerJobs` before the user `start` callback runs.
 *
 * The `command` is declarative data: ts-infra validates and exposes it but
 * never executes it. The consuming application binds it to a queue-backed
 * command handler.
 */
export type SchedulerJobConfig =
    | { readonly name: string; readonly command: string; readonly intervalMinutes: number; readonly cron?: never }
    | { readonly name: string; readonly command: string; readonly cron: string; readonly intervalMinutes?: never };
