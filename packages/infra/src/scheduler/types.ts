/**
 * Scheduler types and interface.
 */

import type { ExecutionContext } from '../execution-policy';

/**
 * Signature for scheduled action handlers. The context carries the shared
 * execution-deadline clock for this tick (A21); zero-argument handlers stay
 * assignable — notably the Cloudflare adapter, which invokes actions with an
 * unlimited execution context (no wall-clock deadline on that runtime).
 */
export type ScheduledAction = (context: ExecutionContext) => Promise<void>;

/** Per-entry execution policy options for {@link SchedulerAdapter.register}. */
export interface ScheduledActionOptions {
    /**
     * Execution policy for this entry's ticks: a positive integer ms deadline,
     * explicit `null` = unlimited, omitted = inherit the adapter default.
     * Invalid explicit values throw at registration time.
     */
    timeoutMs?: number | null;
}

/**
 * Abstract scheduler interface — implementations for Node and Cloudflare.
 *
 * `stop()` cancels future ticks and drains any currently-executing tick,
 * bounded by an implementation-configured timeout (see ADR-024). A stuck
 * action is abandoned at the deadline rather than blocking shutdown forever.
 */
export interface SchedulerAdapter {
    register(cron: string, action: ScheduledAction, options?: ScheduledActionOptions): void;
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
    | {
          readonly name: string;
          readonly command: string;
          readonly intervalMinutes: number;
          readonly cron?: never;
          readonly timeoutMs?: number | null;
      }
    | {
          readonly name: string;
          readonly command: string;
          readonly cron: string;
          readonly intervalMinutes?: never;
          readonly timeoutMs?: number | null;
      };
