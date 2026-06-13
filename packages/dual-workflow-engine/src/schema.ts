import { z } from 'zod';

/** Identifier names reserved for runtime template namespaces; not allowed as user vars. */
const RESERVED_VAR_NAMES = new Set(['task', 'state', 'node', 'iteration', 'run', 'runtime']);

/** Valid identifier pattern for variable and env names. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** User variables: identifier-keyed string map; reserved runtime names are rejected. */
const VarsSchema = z.record(z.string(), z.string()).superRefine((vars, ctx) => {
    for (const key of Object.keys(vars)) {
        if (!IDENTIFIER.test(key)) {
            ctx.addIssue({ code: 'custom', message: `Invalid variable name "${key}" (must be a valid identifier)` });
        }
        if (RESERVED_VAR_NAMES.has(key)) {
            ctx.addIssue({ code: 'custom', message: `Variable name "${key}" is reserved for runtime use` });
        }
    }
});

/** Environment allowlist: identifier-named env vars exposed to templates. */
const EnvSchema = z.object({
    allow: z.array(z.string().regex(IDENTIFIER, 'env.allow entries must be valid identifiers')).optional(),
});

/** Zod schema for workflow action definitions. */
export const ActionDefSchema = z.object({
    kind: z.string().min(1),
    options: z.record(z.string(), z.unknown()).optional(),
    onError: z.enum(['fail', 'continue']).optional(),
});

/** Zod schema for workflow guard definitions. */
export const GuardDefSchema = z.object({
    kind: z.string().min(1),
    options: z.record(z.string(), z.unknown()).optional(),
});

/** Zod schema for state-machine workflow definitions. */
export const StateMachineWorkflowDefSchema = z
    .object({
        $schema: z.string().optional(),
        kind: z.literal('state-machine').optional(),
        name: z.string().min(1),
        // Optional, behavior-free document version tag (accepted for forward/backward compat).
        version: z.string().optional(),
        description: z.string().optional(),
        initialState: z.string().min(1),
        terminalStates: z.array(z.string().min(1)).optional(),
        iterationBound: z.number().int().positive().optional(),
        defaultOnError: z.enum(['fail', 'continue']).optional(),
        vars: VarsSchema.optional(),
        env: EnvSchema.optional(),
        states: z.array(
            z
                .object({
                    id: z.string().min(1),
                    description: z.string().optional(),
                    onEnter: z.array(ActionDefSchema).optional(),
                    onExit: z.array(ActionDefSchema).optional(),
                    /** When true, the engine pauses the run at this state instead of auto-advancing. */
                    pause: z.boolean().optional(),
                })
                .strict(),
        ),
        transitions: z.array(
            z
                .object({
                    from: z.string().min(1),
                    to: z.string().min(1),
                    description: z.string().optional(),
                    trigger: z.string().optional(),
                    guard: GuardDefSchema.optional(),
                })
                .strict(),
        ),
    })
    .strict();

/** Zod schema for transition-flow workflow definitions. */
export const TransitionFlowWorkflowDefSchema = z
    .object({
        $schema: z.string().optional(),
        kind: z.literal('transition-flow'),
        name: z.string().min(1),
        // Optional, behavior-free document version tag (accepted for forward/backward compat).
        version: z.string().optional(),
        description: z.string().optional(),
        initialNode: z.string().min(1),
        terminalNodes: z.array(z.string().min(1)).optional(),
        iterationBound: z.number().int().positive().optional(),
        defaultOnError: z.enum(['fail', 'continue']).optional(),
        vars: VarsSchema.optional(),
        env: EnvSchema.optional(),
        nodes: z.array(
            z
                .object({
                    id: z.string().min(1),
                    description: z.string().optional(),
                    type: z.enum(['action', 'gate', 'parallel', 'decision']).optional(),
                    action: ActionDefSchema.optional(),
                    /** When true, the engine pauses the run at this node instead of auto-advancing. */
                    pause: z.boolean().optional(),
                })
                .strict(),
        ),
        edges: z.array(
            z
                .object({
                    from: z.string().min(1),
                    to: z.string().min(1),
                    description: z.string().optional(),
                    condition: GuardDefSchema.optional(),
                })
                .strict(),
        ),
    })
    .strict();

/** Zod schema for either supported workflow definition shape. */
export const WorkflowDefSchema = z.union([StateMachineWorkflowDefSchema, TransitionFlowWorkflowDefSchema]);
