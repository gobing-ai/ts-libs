import { WorkflowValidationError } from './errors';
import type { OnErrorPolicy, Vars } from './types';

const TEMPLATE_REF = /\$\{([^}]+)\}/g;

/** Runtime context used for workflow variable interpolation. */
export interface VariableContext {
    readonly vars: Vars;
    readonly env: Record<string, string | undefined>;
    readonly builtins?: Record<string, string | number | undefined>;
}

/** Merge workflow vars with caller overrides; caller values win. */
export function mergeVars(workflowVars: Vars = {}, overrideVars: Vars = {}): Vars {
    return { ...workflowVars, ...overrideVars };
}

/**
 * Merge action-set vars into the run-local vars map. Only string→string entries
 * are accepted; non-string values are silently dropped as a defensive measure
 * (the action layer should never produce them, but fail safe).
 */
export function mergeSetVars(vars: Vars, setVars: Vars | undefined): Vars {
    if (setVars === undefined) return vars;
    const filtered: Vars = {};
    for (const [key, value] of Object.entries(setVars)) {
        if (typeof value === 'string') filtered[key] = value;
    }
    return mergeVars(vars, filtered);
}

/** Resolve templates inside an unknown options value. */
export function resolveTemplates<T>(value: T, context: VariableContext): T {
    if (typeof value === 'string') {
        return resolveTemplateString(value, context) as T;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => resolveTemplates(entry, context)) as T;
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
                key,
                resolveTemplates(entry, context),
            ]),
        ) as T;
    }
    return value;
}

/** Resolve a single template string. */
export function resolveTemplateString(value: string, context: VariableContext): string {
    return value.replace(TEMPLATE_REF, (_match, name: string) => {
        return lookupRef(name, context);
    });
}

function lookupRef(name: string, context: VariableContext): string {
    if (name.startsWith('vars.')) {
        const key = name.slice('vars.'.length);
        const resolved = context.vars[key];
        if (resolved === undefined) throw new WorkflowValidationError(`Workflow variable "${key}" is not defined`);
        return resolved;
    }
    if (name.startsWith('env.')) {
        const key = name.slice('env.'.length);
        const resolved = context.env[key];
        if (resolved === undefined) throw new WorkflowValidationError(`Environment variable "${key}" is not defined`);
        return resolved;
    }
    const resolved = context.builtins?.[name];
    if (resolved === undefined) throw new WorkflowValidationError(`Workflow builtin "${name}" is not defined`);
    return String(resolved);
}

/**
 * Env option key carrying the shell-form template bindings (`${__WF_n}` → value).
 * The shell runner forwards it as process env; call sites strip it before persisting.
 */
export const SHELL_ENV_OPTION = '__wfShellEnv';

const SHELL_BINDING = /^\$\{__WF_\d+\}$/;

/** Any reserved placeholder literal in authored command text (task 0087 R2). Braced and unbraced forms both expand at exec time. */
const SHELL_BINDING_ANY = /\$\{__WF_\d+\}|\$__WF_\d+\b/;

/**
 * Resolve options for `shell` actions (task 0086 M1).
 *
 * Shell form (`command`, no `args`): template refs in `command` are rewritten to
 * numbered `${__WF_n}` placeholders and their values ride in the SHELL_ENV_OPTION env
 * map, so substituted text is never reparsed as shell syntax — values survive quotes,
 * `;`, `$()` etc. verbatim. Caveat (fails closed): refs the author quoted with single
 * quotes no longer expand.
 *
 * Argv form (`command` + non-empty `args`): command/args keep raw substitution — the runner
 * uses execFile, which never reparses, so injection is impossible. `args: []` falls through
 * to shell form: the runner picks `/bin/sh -c` whenever there are no argv entries, so the
 * predicates must agree or values would be raw-substituted into a shell line.
 *
 * All other options resolve as plain templates.
 */
export function resolveShellCommandTemplates(
    options: Record<string, unknown>,
    context: VariableContext,
): Record<string, unknown> {
    const { command, args, ...rest } = options;
    if (typeof command !== 'string') return resolveTemplates(rest, context);
    // Task 0087 R1: a defined non-array `args` is an author typo — fail closed with a
    // validation error instead of silently downgrading to shell form. `undefined`
    // and `[]` keep shell form; non-empty arrays keep argv form.
    if (args !== undefined && !Array.isArray(args)) {
        throw new Error(`shell action "args" must be a string array when defined; got ${typeof args}`);
    }
    if (Array.isArray(args) && args.length > 0) {
        return {
            ...resolveTemplates(rest, context),
            command: resolveTemplateString(command, context),
            args: resolveTemplates(args, context),
        };
    }
    const env: Record<string, string> = {};
    let index = 0;
    // Task 0087 R2: the `${__WF_n}` namespace is reserved for this binding pass. An
    // authored command containing a placeholder literal that no binding pass produced
    // would alias (or be aliased by) a bound value — fail closed. Re-resolution of
    // already-bound options (SHELL_ENV_OPTION present) is the idempotent path: seed
    // env/index from the existing map so bindings survive the second pass (ADV-1).
    if (!(SHELL_ENV_OPTION in options) && SHELL_BINDING_ANY.test(command)) {
        throw new Error(
            'shell command must not contain the reserved $__WF_ placeholder namespace; ' +
                'it is minted by the template-binding pass',
        );
    }
    const existingBindings = options[SHELL_ENV_OPTION];
    if (existingBindings !== undefined && typeof existingBindings === 'object' && existingBindings !== null) {
        Object.assign(env, existingBindings);
        while (`__WF_${index}` in env) index++;
    }
    const bound = command.replace(TEMPLATE_REF, (match, name: string) => {
        if (SHELL_BINDING.test(match)) return match; // already-bound placeholder → idempotent
        const key = `__WF_${index++}`;
        env[key] = lookupRef(name, context);
        return `\${${key}}`;
    });
    return { ...resolveTemplates(rest, context), command: bound, [SHELL_ENV_OPTION]: env };
}

/**
 * Resolve the effective error policy via fixed precedence:
 * `action.onError ?? workflow.defaultOnError ?? runOptions.onError ?? 'fail'`.
 */
export function resolveOnErrorPolicy(
    actionOnError: OnErrorPolicy | undefined,
    workflowDefault: OnErrorPolicy | undefined,
    runOptionOverride: OnErrorPolicy | undefined,
): OnErrorPolicy {
    return actionOnError ?? workflowDefault ?? runOptionOverride ?? 'fail';
}
