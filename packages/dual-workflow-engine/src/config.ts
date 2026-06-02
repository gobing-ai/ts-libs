import { loadStructuredConfig } from '@gobing-ai/ts-runtime';
import { parse } from 'yaml';
import { WorkflowValidationError } from './errors';
import { WorkflowDefSchema } from './schema';
import type { WorkflowDef } from './types';

export interface WorkflowLoadOptions {
    /** When true, honor a top-level `$schema` ref. Defaults to true for file loads. */
    validateSchema?: boolean;
    /** Optional fetch implementation for remote HTTP(S) schema refs. */
    fetch?: (input: string) => Promise<Response>;
}

/** Load a workflow definition from YAML or JSON text. */
export function loadWorkflowDefFromText(text: string, source = '<inline>'): WorkflowDef {
    const parsed = source.endsWith('.json') ? JSON.parse(text) : parse(text);
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
    const states = new Set(workflow.states.map((state) => state.id));
    if (!states.has(workflow.initialState)) {
        throw new WorkflowValidationError(`Initial state "${workflow.initialState}" is not declared`);
    }
    for (const transition of workflow.transitions) {
        if (!states.has(transition.from))
            throw new WorkflowValidationError(`Transition source "${transition.from}" is not declared`);
        if (!states.has(transition.to))
            throw new WorkflowValidationError(`Transition target "${transition.to}" is not declared`);
    }
}

function parseWorkflowDef(parsed: unknown, source: string): WorkflowDef {
    const result = WorkflowDefSchema.safeParse(parsed);
    if (!result.success) {
        throw new WorkflowValidationError(
            `Workflow definition failed schema validation for ${source}: ${result.error.issues.map((issue) => issue.message).join('; ')}`,
            result.error.issues,
        );
    }
    validateWorkflowDef(result.data as WorkflowDef);
    return result.data as WorkflowDef;
}

function validateTransitionFlow(workflow: Extract<WorkflowDef, { kind: 'transition-flow' }>): void {
    const nodes = new Set(workflow.nodes.map((node) => node.id));
    if (!nodes.has(workflow.initialNode)) {
        throw new WorkflowValidationError(`Initial node "${workflow.initialNode}" is not declared`);
    }
    for (const edge of workflow.edges) {
        if (!nodes.has(edge.from)) throw new WorkflowValidationError(`Edge source "${edge.from}" is not declared`);
        if (!nodes.has(edge.to)) throw new WorkflowValidationError(`Edge target "${edge.to}" is not declared`);
    }
}
