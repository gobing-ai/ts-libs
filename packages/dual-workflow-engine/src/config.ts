import { loadStructuredConfig, parseYamlObject, type StructuredConfigLoadOptions } from '@gobing-ai/ts-runtime';
import { WorkflowValidationError } from './errors';
import { RUNTIME_BUILTIN_KEYS } from './run-lifecycle';
import { StateMachineWorkflowDefSchema, TransitionFlowWorkflowDefSchema } from './schema';
import type { WorkflowDef } from './types';

/** Loading options for {@link loadWorkflowDef}. */
export interface WorkflowLoadOptions {
    /** When true, honor a top-level `$schema` ref. Defaults to true for file loads. */
    validateSchema?: boolean;
    /** Optional fetch implementation for remote HTTP(S) schema refs. */
    fetch?: (input: string) => Promise<Response>;
    /**
     * Module resolver for bare package-specifier `$schema` refs (e.g.
     * `@scope/pkg/schemas/x.json`). Defaults to `Bun.resolveSync`. Inject this when a
     * bundled-config `$schema` must resolve without reaching `node_modules` — e.g. a
     * `bun --compile` binary, or a validate call running from a cwd outside the package
     * tree (where `Bun.resolveSync` cannot find the owning package).
     */
    resolve?: StructuredConfigLoadOptions['resolve'];
    /**
     * File system used to read the config and local/embedded schema files. Defaults to
     * the Node file system. Pair with {@link WorkflowLoadOptions.resolve} to serve schema
     * text from an in-memory map instead of disk.
     */
    fileSystem?: StructuredConfigLoadOptions['fileSystem'];
}

/** Load a workflow definition from YAML or JSON text. */
export function loadWorkflowDefFromText(text: string, source = '<inline>'): WorkflowDef {
    const parsed = source.endsWith('.json') ? JSON.parse(text) : parseYamlObject(text);
    return parseWorkflowDef(parsed, source);
}

/** Load a workflow definition from a filesystem path. */
export async function loadWorkflowDef(path: string, options: WorkflowLoadOptions = {}): Promise<WorkflowDef> {
    return parseWorkflowDef(await loadStructuredConfig(path, options), path);
}

/** Validate semantic workflow invariants beyond structural Zod checks. */
export function validateWorkflowDef(workflow: WorkflowDef): void {
    if (workflow.kind === 'transition-flow') {
        validateTransitionFlow(workflow);
    } else {
        validateStateMachine(workflow);
    }
}

function validateStateMachine(workflow: Extract<WorkflowDef, { kind?: 'state-machine' }>): void {
    const errors: string[] = [];
    const ids = workflow.states.map((state) => state.id);
    const states = new Set(ids);
    const terminals = new Set(workflow.terminalStates ?? []);

    // Duplicate state ids.
    for (const id of duplicates(ids)) errors.push(`State "${id}" is declared more than once`);

    // Initial state must be declared and must not be terminal.
    if (!states.has(workflow.initialState)) {
        errors.push(`Initial state "${workflow.initialState}" is not declared`);
    } else if (terminals.has(workflow.initialState)) {
        errors.push(`Initial state "${workflow.initialState}" must not be a terminal state`);
    }

    // Terminal states must be declared.
    for (const terminal of terminals) {
        if (!states.has(terminal)) errors.push(`Terminal state "${terminal}" is not declared`);
    }

    // Transition endpoints must be declared.
    type Transition = (typeof workflow.transitions)[number];
    const outboundByState = new Map<string, Transition[]>();
    for (const transition of workflow.transitions) {
        if (!states.has(transition.from)) errors.push(`Transition source "${transition.from}" is not declared`);
        if (!states.has(transition.to)) errors.push(`Transition target "${transition.to}" is not declared`);
        const list = outboundByState.get(transition.from) ?? [];
        list.push(transition);
        outboundByState.set(transition.from, list);
    }

    // Explicit terminal states must not declare outgoing transitions. Note: a state
    // with NO transitions is treated as an implicit terminal by the driver (it stops
    // there), so a missing transition is NOT an error; only an *explicit* terminal
    // that also declares transitions is contradictory.
    for (const state of workflow.states) {
        const outbound = outboundByState.get(state.id) ?? [];
        if (terminals.has(state.id)) {
            if (outbound.length > 0) errors.push(`Terminal state "${state.id}" must not declare transitions`);
            continue;
        }
        // An unguarded transition is unconditional, so anything after it is dead —
        // it must be declared last among a state's outgoing transitions.
        const ungatedIndex = outbound.findIndex((transition) => transition.guard === undefined);
        if (ungatedIndex !== -1 && ungatedIndex < outbound.length - 1) {
            errors.push(
                `State "${state.id}" has an unguarded transition that is not last; later transitions are unreachable`,
            );
        }
    }

    // Template variable references must resolve against declared vars / env allowlist.
    errors.push(...checkVariableReferences(collectActionOptions(workflow), workflow.vars, workflow.env));

    throwIfErrors(workflow, errors);
}

function parseWorkflowDef(parsed: unknown, source: string): WorkflowDef {
    // Parse against the specific dialect schema (not the union) so errors carry the
    // exact failing field path instead of the union's generic "Invalid input".
    const schema = selectWorkflowSchema(parsed);
    const result = schema.safeParse(parsed);
    if (!result.success) {
        throw new WorkflowValidationError(
            `Workflow definition failed schema validation for ${source}: ${formatWorkflowIssues(result.error.issues)}`,
            result.error.issues,
        );
    }
    validateWorkflowDef(result.data as WorkflowDef);
    return result.data as WorkflowDef;
}

/** Pick the dialect schema by the shape of the input so diagnostics are field-precise. */
function selectWorkflowSchema(
    parsed: unknown,
): typeof StateMachineWorkflowDefSchema | typeof TransitionFlowWorkflowDefSchema {
    if (parsed !== null && typeof parsed === 'object') {
        const value = parsed as Record<string, unknown>;
        if (value.kind === 'transition-flow' || 'nodes' in value || 'edges' in value || 'initialNode' in value) {
            return TransitionFlowWorkflowDefSchema;
        }
    }
    return StateMachineWorkflowDefSchema;
}

/** Render Zod issues as `path: message` fragments so the offending field is obvious. */
function formatWorkflowIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
    return issues
        .map((issue) => {
            const path = issue.path.map(String).join('.');
            return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
        })
        .join('; ');
}

function validateTransitionFlow(workflow: Extract<WorkflowDef, { kind: 'transition-flow' }>): void {
    const errors: string[] = [];
    const ids = workflow.nodes.map((node) => node.id);
    const nodes = new Set(ids);

    // Duplicate node ids.
    for (const id of duplicates(ids)) errors.push(`Node "${id}" is declared more than once`);

    // Initial node must be declared.
    if (!nodes.has(workflow.initialNode)) errors.push(`Initial node "${workflow.initialNode}" is not declared`);

    // Edge endpoints must be declared; duplicate from→to edges are ambiguous.
    const seenEdges = new Set<string>();
    for (const edge of workflow.edges) {
        if (!nodes.has(edge.from)) errors.push(`Edge source "${edge.from}" is not declared`);
        if (!nodes.has(edge.to)) errors.push(`Edge target "${edge.to}" is not declared`);
        const key = `${edge.from}→${edge.to}`;
        if (seenEdges.has(key)) errors.push(`Duplicate edge "${key}"`);
        seenEdges.add(key);
    }

    // Template variable references must resolve.
    errors.push(...checkVariableReferences(collectActionOptions(workflow), workflow.vars, workflow.env));

    throwIfErrors(workflow, errors);
}

/** Return the ids that appear more than once, in first-seen order. */
function duplicates(ids: readonly string[]): string[] {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const id of ids) {
        if (seen.has(id)) dupes.add(id);
        seen.add(id);
    }
    return [...dupes];
}

/** Gather every action `options` object across a workflow's states/nodes for template scanning. */
function collectActionOptions(workflow: WorkflowDef): Record<string, unknown>[] {
    const optionSets: Record<string, unknown>[] = [];
    const actions =
        workflow.kind === 'transition-flow'
            ? workflow.nodes.flatMap((node) => (node.action ? [node.action] : []))
            : workflow.states.flatMap((state) => [...(state.onEnter ?? []), ...(state.onExit ?? [])]);
    for (const action of actions) {
        if (action.options) optionSets.push(action.options);
    }
    return optionSets;
}

/**
 * Reserved template namespaces always available at runtime (not user-declared vars).
 * Single-sourced from {@link RUNTIME_BUILTIN_KEYS} so the validator can never drift
 * from the builtins the drivers actually inject at run time.
 */
const RUNTIME_TEMPLATE_NAMESPACES = new Set<string>(RUNTIME_BUILTIN_KEYS);

/**
 * Check `${...}` template references inside action options resolve to something:
 * a declared `vars.X`, an env-allowlisted `env.X`, or a reserved runtime namespace.
 */
function checkVariableReferences(
    optionSets: readonly Record<string, unknown>[],
    vars: Record<string, string> | undefined,
    env: { allow?: readonly string[] } | undefined,
): string[] {
    const declaredVars = new Set(Object.keys(vars ?? {}));
    const allowedEnv = new Set(env?.allow ?? []);
    const errors: string[] = [];
    const reference = /\$\{([^}]+)\}/g;
    for (const options of optionSets) {
        for (const value of Object.values(options)) {
            if (typeof value !== 'string') continue;
            for (const match of value.matchAll(reference)) {
                const expr = (match[1] ?? '').trim();
                const [namespace, name] = expr.includes('.') ? expr.split('.', 2) : [expr, undefined];
                if (namespace === 'vars') {
                    if (name !== undefined && !declaredVars.has(name)) {
                        errors.push(`Unknown variable reference "\${${expr}}" (no var "${name}" declared)`);
                    }
                } else if (namespace === 'env') {
                    if (name !== undefined && !allowedEnv.has(name)) {
                        errors.push(`Env reference "\${${expr}}" is not in env.allow`);
                    }
                } else if (namespace !== undefined && !RUNTIME_TEMPLATE_NAMESPACES.has(namespace)) {
                    errors.push(`Unknown template reference "\${${expr}}"`);
                }
            }
        }
    }
    return errors;
}

/** Throw a single aggregated validation error when any invariant failed. */
function throwIfErrors(workflow: WorkflowDef, errors: readonly string[]): void {
    if (errors.length > 0) {
        throw new WorkflowValidationError(`Workflow "${workflow.name}" is invalid: ${errors.join('; ')}`, errors);
    }
}
