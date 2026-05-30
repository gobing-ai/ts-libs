import { WorkflowValidationError } from './errors';
import type { Vars } from './types';

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
        if (name.startsWith('vars.')) {
            const key = name.slice('vars.'.length);
            const resolved = context.vars[key];
            if (resolved === undefined) throw new WorkflowValidationError(`Workflow variable "${key}" is not defined`);
            return resolved;
        }
        if (name.startsWith('env.')) {
            const key = name.slice('env.'.length);
            const resolved = context.env[key];
            if (resolved === undefined)
                throw new WorkflowValidationError(`Environment variable "${key}" is not defined`);
            return resolved;
        }
        const resolved = context.builtins?.[name];
        if (resolved === undefined) throw new WorkflowValidationError(`Workflow builtin "${name}" is not defined`);
        return String(resolved);
    });
}
