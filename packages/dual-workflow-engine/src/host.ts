import { NodeProcessExecutor, type ProcessExecutor } from '@gobing-ai/ts-runtime';
import { WorkflowValidationError } from './errors';
import type { ActionResult, ActionRunContext, ActionRunner, GuardContext, GuardRunner } from './types';

/** Registry owner for workflow actions and guards. */
export class WorkflowEngineHost {
    private readonly actions = new Map<string, ActionRunner>();
    private readonly guards = new Map<string, GuardRunner>();

    /** Register or replace an action runner. */
    registerAction(action: ActionRunner): this {
        this.actions.set(action.kind, action);
        return this;
    }

    /** Register or replace a guard runner. */
    registerGuard(guard: GuardRunner): this {
        this.guards.set(guard.kind, guard);
        return this;
    }

    /** Execute a registered action. */
    async runAction(kind: string, options: Record<string, unknown>, context: ActionRunContext): Promise<ActionResult> {
        const action = this.actions.get(kind);
        if (action === undefined) throw new WorkflowValidationError(`Unknown workflow action "${kind}"`);
        return await action.execute(options, context);
    }

    /** Evaluate a registered guard. */
    async evaluateGuard(kind: string, options: Record<string, unknown>, context: GuardContext): Promise<boolean> {
        const guard = this.guards.get(kind);
        if (guard === undefined) throw new WorkflowValidationError(`Unknown workflow guard "${kind}"`);
        return await guard.evaluate(options, context);
    }
}

/** Create a workflow host with built-in note, shell, always, and action-ok capabilities. */
export function createDefaultWorkflowEngineHost(
    options: { processExecutor?: ProcessExecutor } = {},
): WorkflowEngineHost {
    const host = new WorkflowEngineHost();
    host.registerAction(new NoteActionRunner());
    host.registerAction(new ShellActionRunner(options.processExecutor ?? new NodeProcessExecutor()));
    host.registerGuard({ kind: 'always', evaluate: async () => true });
    host.registerGuard({ kind: 'never', evaluate: async () => false });
    host.registerGuard({
        kind: 'action-ok',
        evaluate: async (_options, context) => context.lastActionResult?.ok === true,
    });
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

    /** Execute a shell command with optional args and cwd. */
    async execute(options: Record<string, unknown>, context: ActionRunContext): Promise<ActionResult> {
        const command = stringOption(options, 'command');
        const args = arrayOption(options, 'args');
        const result = await this.processExecutor.run({
            command,
            args,
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
