import type { BusLifecycleEvents, EventBus } from '@gobing-ai/ts-infra';
import { nodeBunFactory, type ProcessExecutor } from '@gobing-ai/ts-runtime';
import { type CapabilityOrigin, CapabilityRegistry } from '@gobing-ai/ts-runtime/extension';
import { WorkflowValidationError } from './errors';
import type {
    ActionResult,
    ActionRunContext,
    ActionRunner,
    GuardContext,
    GuardEvaluationResult,
    GuardRunner,
} from './types';
import { SHELL_ENV_OPTION } from './variables';

/** Registry owner for workflow actions and guards. */
export class WorkflowEngineHost {
    private readonly actions = new CapabilityRegistry<ActionRunner>('workflow action');
    private readonly guards = new CapabilityRegistry<GuardRunner>('workflow guard');

    constructor(readonly lifecycleBus?: EventBus<BusLifecycleEvents>) {}

    /** Register or replace an action runner. */
    registerAction(action: ActionRunner, origin: CapabilityOrigin = 'extension'): this {
        this.actions.register(action.kind, action, origin);
        return this;
    }

    /** Register or replace a guard runner. */
    registerGuard(guard: GuardRunner, origin: CapabilityOrigin = 'extension'): this {
        this.guards.register(guard.kind, guard, origin);
        return this;
    }

    /** Return true when an action of `kind` is registered. */
    hasAction(kind: string): boolean {
        return this.actions.has(kind);
    }

    /** Return true when a guard of `kind` is registered. */
    hasGuard(kind: string): boolean {
        return this.guards.has(kind);
    }

    /** List registered action kinds in registration order. */
    listActions(): string[] {
        return this.actions.list();
    }

    /** List registered guard kinds in registration order. */
    listGuards(): string[] {
        return this.guards.list();
    }

    /** Origin of a registered action, or undefined if none. Lets 0010 distinguish builtin from extension overrides. */
    actionOrigin(kind: string): CapabilityOrigin | undefined {
        return this.actions.getEntry(kind)?.origin;
    }

    /** Origin of a registered guard, or undefined if none. */
    guardOrigin(kind: string): CapabilityOrigin | undefined {
        return this.guards.getEntry(kind)?.origin;
    }

    /** Execute a registered action. */
    async runAction(kind: string, options: Record<string, unknown>, context: ActionRunContext): Promise<ActionResult> {
        // Guard at the host boundary so unknown kinds surface as WorkflowValidationError,
        // not the shared registry's generic Error (ADR-010 R13).
        if (!this.actions.has(kind)) throw new WorkflowValidationError(`Unknown workflow action "${kind}"`);
        return await this.actions.get(kind).execute(options, context);
    }

    /** Evaluate a registered guard. */
    async evaluateGuard(kind: string, options: Record<string, unknown>, context: GuardContext): Promise<boolean> {
        return (await this.evaluateGuardResult(kind, options, context)).passed;
    }

    /** Evaluate a registered guard and preserve any machine-readable report it returns. */
    async evaluateGuardResult(
        kind: string,
        options: Record<string, unknown>,
        context: GuardContext,
    ): Promise<GuardEvaluationResult> {
        if (!this.guards.has(kind)) throw new WorkflowValidationError(`Unknown workflow guard "${kind}"`);
        const result = await this.guards.get(kind).evaluate(options, context);
        return typeof result === 'boolean' ? { passed: result } : result;
    }
}

/** Create a workflow host with built-in note, shell, always, and action-ok capabilities. */
export function createDefaultWorkflowEngineHost(
    options: { processExecutor?: ProcessExecutor; lifecycleBus?: EventBus<BusLifecycleEvents> } = {},
): WorkflowEngineHost {
    const host = new WorkflowEngineHost(options.lifecycleBus);
    host.registerAction(new NoteActionRunner(), 'builtin');
    host.registerAction(
        new ShellActionRunner(options.processExecutor ?? nodeBunFactory.createProcessExecutor()),
        'builtin',
    );
    host.registerAction(new EventEmitActionRunner(), 'builtin');
    host.registerGuard(
        new ShellGuardRunner(options.processExecutor ?? nodeBunFactory.createProcessExecutor()),
        'builtin',
    );
    host.registerGuard({ kind: 'always', evaluate: async () => true }, 'builtin');
    host.registerGuard({ kind: 'never', evaluate: async () => false }, 'builtin');
    host.registerGuard(
        {
            kind: 'action-ok',
            evaluate: async (_options, context) => context.lastActionResult?.ok === true,
        },
        'builtin',
    );
    return host;
}

/** Built-in action that records a note and emits a workflow.hitl.note event. */
export class NoteActionRunner implements ActionRunner {
    readonly kind = 'note';

    /** Execute a no-op note action with observable event emission. */
    async execute(options: Record<string, unknown>, context?: ActionRunContext): Promise<ActionResult> {
        const message = String(options.message ?? '');
        void context?.events?.emit('workflow.hitl.note', {
            runId: context.runId,
            node: context.stateOrNodeId,
            message,
            severity: 'info',
        });
        return { ok: true, data: { message } };
    }
}

/** Built-in action that emits a typed `workflow.custom` event on the run's event bus. */
export class EventEmitActionRunner implements ActionRunner {
    readonly kind = 'event.emit';

    async execute(options: Record<string, unknown>, context?: ActionRunContext): Promise<ActionResult> {
        const name = String(options.name ?? '');
        if (!name) return { ok: false, error: 'event.emit requires a non-empty "name" option' };
        const payload = (options.payload as Record<string, unknown>) ?? {};
        void context?.events?.emit('workflow.custom', { name, payload, severity: 'info' });
        return { ok: true, data: { name, payload } };
    }
}

/** Process output shared by the shell action and guard runners. */
interface ShellSpawnOutcome {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number | null;
    readonly timedOut: boolean;
}

/**
 * Shared spawn path for ShellActionRunner and ShellGuardRunner (task 0086 R2).
 *
 * Two forms (R4/R3): `command` + explicit `args` → execFile argv (no shell, template
 * values substituted raw are inert); `command` alone → `/bin/sh -c`, with
 * `SHELL_ENV_OPTION` bindings forwarded as env so substituted text is never reparsed
 * as shell syntax.
 */
async function spawnShellCommand(
    processExecutor: ProcessExecutor,
    options: Record<string, unknown>,
    workdir: string | undefined,
): Promise<ShellSpawnOutcome> {
    const command = stringOption(options, 'command');
    const explicitArgs = arrayOption(options, 'args');
    const usesShell = explicitArgs.length === 0;
    const spawn = usesShell ? { command: '/bin/sh', args: ['-c', command] } : { command, args: explicitArgs };
    const timeout = optionalTimeoutOption(options);
    const envOption = options[SHELL_ENV_OPTION];
    const env = envOption !== null && typeof envOption === 'object' ? (envOption as Record<string, string>) : undefined;
    const result = await processExecutor.run({
        command: spawn.command,
        args: spawn.args,
        cwd: optionalStringOption(options, 'cwd', workdir),
        ...(env !== undefined ? { env, envMode: 'merge' as const } : {}),
        ...(timeout !== undefined ? { timeout } : {}),
        rejectOnError: false,
        forceBuffered: true,
    });
    return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: result.outcome === 'timeout',
    };
}

/** Built-in shell action backed by ts-runtime ProcessExecutor. */
export class ShellActionRunner implements ActionRunner {
    readonly kind = 'shell';

    constructor(private readonly processExecutor: ProcessExecutor) {}

    /**
     * Execute a shell command. Two forms:
     * - `command` + explicit `args` → run `command` as a program with those argv (no shell).
     * - `command` alone → treat it as a shell command line and run it via `sh -c`, so operators
     *   can use shell features (`&&`, `|`, quoting, globs) as in `bun run autofix && bun run spur-check`.
     *
     * The bare-`command` form is by far the common case; running it directly as a program name —
     * the old behavior — fails with a null exit code for any line containing spaces.
     */
    async execute(options: Record<string, unknown>, context: ActionRunContext): Promise<ActionResult> {
        const spawn = await spawnShellCommand(this.processExecutor, options, context.workdir);
        if (spawn.timedOut) {
            const timeout = optionalTimeoutOption(options);
            return {
                ok: false,
                data: { stdout: spawn.stdout, stderr: spawn.stderr, exitCode: spawn.exitCode, timedOut: true },
                error: `Shell action timed out after ${timeout}ms`,
            };
        }
        const command = stringOption(options, 'command');
        return {
            ok: spawn.exitCode === 0,
            data: { stdout: spawn.stdout, stderr: spawn.stderr, exitCode: spawn.exitCode },
            ...(spawn.exitCode === 0 ? {} : { error: `Command "${command}" exited with ${spawn.exitCode}` }),
        };
    }
}

/** Built-in shell guard backed by ts-runtime ProcessExecutor; passes when the command exits with 0. */
export class ShellGuardRunner implements GuardRunner {
    readonly kind = 'shell';

    constructor(private readonly processExecutor: ProcessExecutor) {}

    async evaluate(options: Record<string, unknown>, context: GuardContext): Promise<GuardEvaluationResult> {
        const spawn = await spawnShellCommand(this.processExecutor, options, context.workdir);
        return {
            passed: !spawn.timedOut && spawn.exitCode === 0,
            report: {
                stdout: spawn.stdout,
                stderr: spawn.stderr,
                exitCode: spawn.exitCode,
                ...(spawn.timedOut ? { timedOut: true } : {}),
            },
        };
    }
}

function stringOption(options: Record<string, unknown>, key: string, fallback?: string): string {
    const value = options[key];
    if (typeof value === 'string') return value;
    if (fallback !== undefined) return fallback;
    throw new WorkflowValidationError(`Action option "${key}" must be a string`);
}

function optionalStringOption(options: Record<string, unknown>, key: string, fallback?: string): string | undefined {
    const value = options[key];
    if (typeof value === 'string') return value;
    if (value === undefined) return fallback;
    throw new WorkflowValidationError(`Action option "${key}" must be a string`);
}

function arrayOption(options: Record<string, unknown>, key: string): string[] {
    const value = options[key];
    if (value === undefined) return [];
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value;
    throw new WorkflowValidationError(`Action option "${key}" must be a string array`);
}

/**
 * Resolve the optional `timeout` option in milliseconds (task 0086 AC14). Undefined
 * passes through; anything that is not a finite positive number is rejected.
 */
function optionalTimeoutOption(options: Record<string, unknown>): number | undefined {
    const value = options.timeout;
    if (value === undefined) return undefined;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    throw new WorkflowValidationError('shell option "timeout" must be a positive number of milliseconds');
}
