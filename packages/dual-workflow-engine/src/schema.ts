import { z } from 'zod';

/** Zod schema for workflow action definitions. */
export const ActionDefSchema = z.object({
    kind: z.string().min(1),
    options: z.record(z.string(), z.unknown()).optional(),
});

/** Zod schema for workflow guard definitions. */
export const GuardDefSchema = z.object({
    kind: z.string().min(1),
    options: z.record(z.string(), z.unknown()).optional(),
});

/** Zod schema for state-machine workflow definitions. */
export const StateMachineWorkflowDefSchema = z.object({
    $schema: z.string().optional(),
    kind: z.literal('state-machine').optional(),
    name: z.string().min(1),
    initialState: z.string().min(1),
    terminalStates: z.array(z.string().min(1)).optional(),
    iterationBound: z.number().int().positive().optional(),
    vars: z.record(z.string(), z.string()).optional(),
    env: z.object({ allow: z.array(z.string()).optional() }).optional(),
    states: z.array(
        z.object({
            id: z.string().min(1),
            onEnter: z.array(ActionDefSchema).optional(),
            onExit: z.array(ActionDefSchema).optional(),
        }),
    ),
    transitions: z.array(
        z.object({
            from: z.string().min(1),
            to: z.string().min(1),
            trigger: z.string().optional(),
            guard: GuardDefSchema.optional(),
        }),
    ),
});

/** Zod schema for transition-flow workflow definitions. */
export const TransitionFlowWorkflowDefSchema = z.object({
    $schema: z.string().optional(),
    kind: z.literal('transition-flow'),
    name: z.string().min(1),
    initialNode: z.string().min(1),
    terminalNodes: z.array(z.string().min(1)).optional(),
    iterationBound: z.number().int().positive().optional(),
    vars: z.record(z.string(), z.string()).optional(),
    env: z.object({ allow: z.array(z.string()).optional() }).optional(),
    nodes: z.array(
        z.object({
            id: z.string().min(1),
            type: z.enum(['action', 'gate', 'parallel', 'decision']).optional(),
            action: ActionDefSchema.optional(),
        }),
    ),
    edges: z.array(
        z.object({
            from: z.string().min(1),
            to: z.string().min(1),
            condition: GuardDefSchema.optional(),
        }),
    ),
});

/** Zod schema for either supported workflow definition shape. */
export const WorkflowDefSchema = z.union([StateMachineWorkflowDefSchema, TransitionFlowWorkflowDefSchema]);
