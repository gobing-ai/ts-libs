/**
 * Executor-owned process-group containment (task 0087 R8): deadline resolution,
 * group liveness probes, SIGTERM→SIGKILL escalation, and reap lifecycle for
 * process groups spawned by NodeProcessExecutor. Extracted from
 * process-executor.ts as a pure move — no behavior change.
 */

import type { ProcessOutcome } from './process-executor';

/**
 * Largest delay accepted by native timers; anything larger would overflow onto an
 * immediate timer, so deadline/grace values beyond it are rejected before spawn.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Default grace between the owned group SIGTERM and the SIGKILL escalation. */
const DEFAULT_KILL_GRACE_MS = 5000;

/** Poll cadence while waiting for an owned process group to empty. */
const GROUP_POLL_INTERVAL_MS = 25;

/** Bounded patience after group SIGKILL before giving up on unkillable (D-state) members. */
const GROUP_KILL_PATIENCE_MS = 2000;

/**
 * Resolve the effective deadline: omitted inherits the executor default (which may itself
 * be unlimited), explicit `null` is unlimited and overrides any finite default, and a
 * finite value must be a positive integer within the native timer range. Invalid values
 * are rejected before spawn — never clamped and never overflowed onto a timer.
 */
export function resolveDeadline(
    optionTimeout: number | null | undefined,
    defaultTimeout: number | null | undefined,
): number | null | undefined {
    if (optionTimeout === null) return null;
    const candidate = optionTimeout === undefined ? defaultTimeout : optionTimeout;
    if (candidate === undefined || candidate === null) return candidate;
    if (!Number.isInteger(candidate) || candidate <= 0 || candidate > MAX_TIMEOUT_MS) {
        throw new TypeError(
            `Process timeout must be a positive integer within the native timer range (1-${MAX_TIMEOUT_MS} ms), got ${String(candidate)}`,
        );
    }
    return candidate;
}

/**
 * Resolve the SIGTERM→SIGKILL escalation grace: omitted uses {@link DEFAULT_KILL_GRACE_MS},
 * `0` escalates immediately, and anything outside the native timer range is rejected.
 */
export function resolveKillGraceMs(optionGraceMs: number | undefined): number {
    if (optionGraceMs === undefined) return DEFAULT_KILL_GRACE_MS;
    if (!Number.isInteger(optionGraceMs) || optionGraceMs < 0 || optionGraceMs > MAX_TIMEOUT_MS) {
        throw new TypeError(
            `Process killGraceMs must be a non-negative integer within the native timer range (0-${MAX_TIMEOUT_MS} ms), got ${String(optionGraceMs)}`,
        );
    }
    return optionGraceMs;
}

/** Whether any member of the owned process group is still alive (signal 0 probe on `-pid`). */
function groupExists(pid: number): boolean {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        // EPERM means the group exists but is not signallable from here.
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/** Signal the owned process group; `false` when the group is already gone (ESRCH). */
function signalGroup(pid: number, signal: NodeJS.Signals | number): boolean {
    try {
        process.kill(-pid, signal);
        return true;
    } catch {
        return false;
    }
}

async function waitForGroupExit(pid: number, budgetMs: number): Promise<boolean> {
    const giveUpAt = Date.now() + budgetMs;
    while (groupExists(pid)) {
        if (Date.now() >= giveUpAt) return false;
        await new Promise<void>((resolve) => setTimeout(resolve, GROUP_POLL_INTERVAL_MS));
    }
    return true;
}

/**
 * The one termination sequence for an owned Unix process group: group SIGTERM, wait the
 * grace for the whole group to empty, then group SIGKILL and a bounded settle wait.
 * Group liveness — not direct-child exit — decides completion, so escalation is never
 * cancelled because the leader exited first while descendants retain pipes or locks.
 * Resolves `true` only when a group signal was actually delivered.
 */
async function reapProcessGroup(pid: number, graceMs: number): Promise<boolean> {
    if (!signalGroup(pid, 'SIGTERM')) return false;
    if (await waitForGroupExit(pid, graceMs)) return true;
    signalGroup(pid, 'SIGKILL');
    await waitForGroupExit(pid, GROUP_KILL_PATIENCE_MS);
    return true;
}

/** Handle for the executor-owned termination of one spawned process group. */
export interface ProcessGroupOwnership {
    /**
     * Settle the run's termination: resolve the outcome delivered by the executor's own
     * path (deadline `timeout` or external `cancelled`) after the escalation completed, or
     * reap surviving owned descendants after a natural leader exit (outcome stays `exit`).
     * Call exactly once, after the execa promise has settled; bounded, never hangs.
     */
    finish(): Promise<ProcessOutcome | undefined>;
    /** Release the deadline timer and abort listener once the execa promise has settled. */
    stop(): void;
}

/**
 * Own one detached child's process group on Unix. A deadline timer and the caller's abort
 * signal both feed a single termination path — group SIGTERM, grace, SIGKILL — and after a
 * natural leader exit surviving owned descendants are reaped with the same sequence, so
 * completion cannot leak group members holding inherited pipes or database write locks.
 */
export function ownProcessGroupLifecycle(ownership: {
    pid: number;
    deadlineMs: number | undefined;
    signal: AbortSignal | undefined;
    graceMs: number;
}): ProcessGroupOwnership {
    const { pid, graceMs } = ownership;
    let trigger: 'timeout' | 'cancelled' | undefined;
    let termination: Promise<boolean> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const initiate = (reason: 'timeout' | 'cancelled'): void => {
        if (trigger !== undefined) return;
        trigger = reason;
        termination = reapProcessGroup(pid, graceMs);
    };

    if (ownership.deadlineMs !== undefined) {
        timer = setTimeout(() => initiate('timeout'), ownership.deadlineMs);
    }
    const onAbort = (): void => initiate('cancelled');
    if (ownership.signal !== undefined) {
        if (ownership.signal.aborted) onAbort();
        else ownership.signal.addEventListener('abort', onAbort, { once: true });
    }

    return {
        finish: async () => {
            if (trigger === undefined) {
                // Natural completion: reap stragglers (no-op when the group is already empty).
                await reapProcessGroup(pid, graceMs);
                return undefined;
            }
            // An undeliverable trigger (group already gone — the child finished first)
            // yields undefined so the outcome falls back to the natural classification.
            return (await termination) ? trigger : undefined;
        },
        stop: () => {
            if (timer !== undefined) clearTimeout(timer);
            ownership.signal?.removeEventListener('abort', onAbort);
        },
    };
}
