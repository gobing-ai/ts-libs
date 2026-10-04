import { assertRelativeExtensionPath } from '@gobing-ai/ts-runtime/extension';
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

/**
 * Extension module paths must be relative and must not escape the declaring
 * directory. Mirrors rule-engine's private helper; the real guard is the shared
 * `assertRelativeExtensionPath` (ADR-010) so schema-time and load-time
 * validation share one source of truth.
 */
const relativeExtensionPath = z
    .string()
    .min(1)
    .superRefine((value, ctx) => {
        try {
            assertRelativeExtensionPath(value);
        } catch (error) {
            ctx.addIssue({
                code: 'custom',
                message: error instanceof Error ? error.message : 'invalid extension path',
            });
        }
    });

/**
 * Rule-style `extensions` block for workflow YAML: relative module paths for
 * the two extension-loadable capability kinds. `.strict()` rejects unknown keys
 * (e.g. `evaluators` or `plugins`).
 */
export const WorkflowExtensionsSchema = z
    .object({
        actions: z.array(relativeExtensionPath).optional(),
        guards: z.array(relativeExtensionPath).optional(),
    })
    .strict();

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
        failureStates: z.array(z.string().min(1)).optional(),
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
                    /** Author declaration that re-running this state's on-enter actions after an interruption is safe. */
                    resumeRerun: z.boolean().optional(),
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
                    /** Declared terminal reason carried onto the runs row when this edge closes the run. */
                    terminalReason: z.string().optional(),
                })
                .strict(),
        ),
        extensions: WorkflowExtensionsSchema.optional(),
    })
    .strict();

/** Zod schema for structured parallel branch definitions. */
export const FlowParallelBranchDefSchema = z
    .object({
        id: z.string().min(1),
        startNode: z.string().min(1),
        description: z.string().optional(),
    })
    .strict();

/** Zod schema for transition-flow node definitions. */
export const FlowNodeDefSchema = z
    .object({
        id: z.string().min(1),
        description: z.string().optional(),
        type: z.enum(['action', 'gate', 'parallel', 'decision']).optional(),
        action: ActionDefSchema.optional(),
        /** When true, the engine pauses the run at this node instead of auto-advancing. */
        pause: z.boolean().optional(),
        /** Author declaration that re-running this node's action after an interruption is safe. */
        resumeRerun: z.boolean().optional(),
        /** Declared branches for parallel fork nodes (type: 'parallel'). */
        branches: z.array(FlowParallelBranchDefSchema).optional(),
        /** Target join node ID where branches converge for parallel fork nodes. */
        join: z.string().min(1).optional(),
        /** Join synchronization policy for parallel nodes. Defaults to 'all'. */
        joinPolicy: z.enum(['all']).optional(),
        /** Failure handling policy across parallel branches. Defaults to 'collect'. */
        failurePolicy: z.enum(['collect', 'fail-fast']).optional(),
        /** Maximum number of branches executed concurrently. Defaults to 4. */
        concurrencyLimit: z.number().int().positive().optional(),
    })
    .strict()
    .superRefine((node, ctx) => {
        if (node.type === 'parallel') {
            if (!node.branches || node.branches.length === 0) {
                ctx.addIssue({
                    code: 'custom',
                    message: 'Parallel node must declare non-empty branches array',
                    path: ['branches'],
                });
            }
            if (!node.join) {
                ctx.addIssue({
                    code: 'custom',
                    message: 'Parallel node must declare join target node ID',
                    path: ['join'],
                });
            }
        } else {
            if (node.branches !== undefined) {
                ctx.addIssue({
                    code: 'custom',
                    message: `Node "${node.id}" of type "${node.type ?? 'action'}" must not declare branches`,
                    path: ['branches'],
                });
            }
            if (node.join !== undefined) {
                ctx.addIssue({
                    code: 'custom',
                    message: `Node "${node.id}" of type "${node.type ?? 'action'}" must not declare join`,
                    path: ['join'],
                });
            }
        }
    });

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
        nodes: z.array(FlowNodeDefSchema),
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
        extensions: WorkflowExtensionsSchema.optional(),
    })
    .strict();

/** Zod schema for either supported workflow definition shape. */
export const WorkflowDefSchema = z.union([StateMachineWorkflowDefSchema, TransitionFlowWorkflowDefSchema]);
