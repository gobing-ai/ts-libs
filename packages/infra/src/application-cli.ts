/**
 * CLI convenience bootstrap for `@gobing-ai/ts-infra`.
 *
 * Wraps {@link runNodeApplication} with the one thing every CLI does at the
 * end: map the command result to a process exit code, and terminate. Same
 * option shape, same defaults, same callback contract — no surprises.
 *
 * Differences from `runNodeApplication`:
 * - `start` returns `number | void` instead of `void`. The number becomes the
 *   process exit code (void = 0). This is the Commander convention.
 * - After `start` resolves, the runtime is shut down gracefully
 *   (`app.stop('shutdown')`) and `process.exit(code)` is called.
 * - If `start` throws (or startup fails), the error message is written to
 *   stderr and the process exits with code 1. `runNodeApplication`'s built-in
 *   reverse-order cleanup (telemetry, owned DB, user `stop` callback) runs
 *   before the rethrow, so resources are released.
 *
 * Use this for fire-and-forget CLIs (Commander, Yargs, etc.). For long-running
 * services (servers, daemons, workers), use `runNodeApplication` directly — it
 * returns a runtime handle you control.
 *
 * @example
 * ```ts
 * import { runCliApplication } from '@gobing-ai/ts-infra/application-cli';
 *
 * await runCliApplication({
 *     async start(app) {
 *         app.logger.info('running');
 *         return doWork(); // returns exit code
 *     },
 * });
 * ```
 */

import type { ApplicationRuntime, ApplicationStopReason, EventMap, InfraEvents } from './application/types';
import { type NodeApplicationOptions, runNodeApplication } from './application-node';

/** Options for the CLI convenience {@link runCliApplication}. */
export interface CliApplicationOptions<TAppConfig = unknown, TEvents extends EventMap = InfraEvents>
    extends Omit<NodeApplicationOptions<TAppConfig, TEvents>, 'start' | 'stop'> {
    /**
     * User callback: CLI logic. Called after all services are ready.
     * Return a number to set the process exit code; void/undefined means success (0).
     */
    readonly start: (app: ApplicationRuntime<TAppConfig, TEvents>) => Promise<number | undefined> | number | undefined;
    /**
     * User callback: cleanup before services shut down. Receives the stop
     * reason: `'shutdown'` on normal completion, `'error'` if `start` threw.
     */
    readonly stop?: (
        app: ApplicationRuntime<TAppConfig, TEvents>,
        reason: ApplicationStopReason,
    ) => Promise<void> | void;
}

/**
 * CLI convenience application bootstrap.
 *
 * Delegates to {@link runNodeApplication} for all service lifecycle (logger,
 * telemetry, events, DB, scheduler, plugins), then maps the `start` result to
 * a process exit code and terminates. See the module docstring for details.
 *
 * @returns Never resolves — calls `process.exit` internally.
 */
export async function runCliApplication<TAppConfig = unknown, TEvents extends EventMap = InfraEvents>(
    options: CliApplicationOptions<TAppConfig, TEvents>,
): Promise<never> {
    let exitCode = 0;

    try {
        const app = await runNodeApplication<TAppConfig, TEvents>({
            ...options,
            start: async (runtime) => {
                const code = await options.start(runtime);
                if (typeof code === 'number') exitCode = code;
            },
        });

        // `start` completed — graceful reverse-order shutdown of all services.
        await app.stop('shutdown');
    } catch (error) {
        // Startup failure OR `start` threw. `runNodeApplication`'s catch block
        // already ran stopAll/unloadAll on whatever started, so resources are
        // released. We just normalize the exit code and surface the message.
        exitCode = 1;
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Error: ${msg}\n`);
    }

    process.exit(exitCode);
}
