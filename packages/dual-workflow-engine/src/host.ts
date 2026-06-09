import { NodeProcessExecutor, type ProcessExecutor } from '@gobing-ai/ts-runtime';
import { type CapabilityOrigin, CapabilityRegistry } from '@gobing-ai/ts-runtime/extension';
import { WorkflowValidationError } from './errors';
import type { ActionResult, ActionRunContext, ActionRunner, GuardContext, GuardRunner } from './types';

/** Registry owner for workflow actions and guards. */
export class WorkflowEngineHost {
    private readonly actions = new CapabilityRegistry<ActionRunner>('workflow action');
    private readonly guards = new CapabilityRegistry<GuardRunner>('workflow guard');

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
        if (!this.guards.has(kind)) throw new WorkflowValidationError(`Unknown workflow guard "${kind}"`);
        return await this.guards.get(kind).evaluate(options, context);
    }
}

/** Create a workflow host with built-in note, shell, always, and action-ok capabilities. */
export function createDefaultWorkflowEngineHost(
    options: { processExecutor?: ProcessExecutor } = {},
): WorkflowEngineHost {
    const host = new WorkflowEngineHost();
    host.registerAction(new NoteActionRunner(), 'builtin');
    host.registerAction(new ShellActionRunner(options.processExecutor ?? new NodeProcessExecutor()), 'builtin');
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

/** Built-in action that records a note in result data. */
export class NoteActionRunner implements ActionRunner {
    readonly kind = 'note';

    /** Execute a no-op note action. */
    async execute(options: Record<string, unknown>): Promise<ActionResult> {
        return { ok: true, data: { message: String(options.message ?? '') } };
    }
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
        const command = stringOption(options, 'command');
        const explicitArgs = arrayOption(options, 'args');
        const usesShell = explicitArgs.length === 0;
        const spawn = usesShell ? { command: '/bin/sh', args: ['-c', command] } : { command, args: explicitArgs };
        const result = await this.processExecutor.run({
            command: spawn.command,
            args: spawn.args,
            cwd: stringOption(options, 'cwd', context.workdir),
            rejectOnError: false,
            forceBuffered: true,
        });
        return {
            ok: result.exitCode === 0,
            data: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
            ...(result.exitCode === 0 ? {} : { error: `Command "${command}" exited with ${result.exitCode}` }),
        };
    }
}

function stringOption(options: Record<string, unknown>, key: string, fallback?: string): string {
    const value = options[key];
    if (typeof value === 'string') return value;
    if (fallback !== undefined) return fallback;
    throw new WorkflowValidationError(`Action option "${key}" must be a string`);
}

function arrayOption(options: Record<string, unknown>, key: string): string[] {
    const value = options[key];
    if (value === undefined) return [];
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value;
    throw new WorkflowValidationError(`Action option "${key}" must be a string array`);
}
