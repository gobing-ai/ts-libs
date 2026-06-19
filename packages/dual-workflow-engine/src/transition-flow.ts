import { runActionStep } from './action-step';
import { FSMError } from './errors';
import type { WorkflowEngineHost } from './host';
import { allowedEnv, RunLifecycle } from './run-lifecycle';
import type {
    ActionResult,
    TransitionFlowWorkflowDef,
    WorkflowPersistenceAdapter,
    WorkflowRunOptions,
    WorkflowRunResult,
} from './types';
import { mergeSetVars, mergeVars, resolveTemplates } from './variables';

/** Dependencies required by the transition-flow driver. */
export interface TransitionFlowDriverOptions {
    readonly host: WorkflowEngineHost;
    readonly persistence: WorkflowPersistenceAdapter;
}

/** Transition-flow workflow driver with an R7 single control function. */
export class TransitionFlowDriver {
    constructor(private readonly options: TransitionFlowDriverOptions) {}

    /** Run a transition-flow workflow to completion or failure. */
    async run(workflow: TransitionFlowWorkflowDef, options: WorkflowRunOptions = {}): Promise<WorkflowRunResult> {
        return await RunLifecycle.run(
            workflow.name,
            'transition-flow',
            { persistence: this.options.persistence, events: options.events },
            options,
            (lifecycle) => this.loop(workflow, options, lifecycle),
        );
    }

    /** Resume a paused transition-flow run from the given node, skipping node action. */
    async resume(
        workflow: TransitionFlowWorkflowDef,
        runId: string,
        resumeFromNode: string,
        externalKey: string | undefined,
        options: WorkflowRunOptions = {},
    ): Promise<WorkflowRunResult> {
        return await RunLifecycle.resume(
            workflow.name,
            'transition-flow',
            { persistence: this.options.persistence, events: options.events },
            runId,
            externalKey,
            (lifecycle) => this.loop(workflow, options, lifecycle, resumeFromNode),
        );
    }

    private async loop(
        workflow: TransitionFlowWorkflowDef,
        options: WorkflowRunOptions,
        lifecycle: RunLifecycle,
        resumeFromNode?: string,
    ): Promise<WorkflowRunResult> {
        const runId = lifecycle.runId;
        const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
        const terminal = new Set(workflow.terminalNodes ?? []);
        let vars = mergeVars(workflow.vars, options.vars);
        const env = allowedEnv(workflow.env?.allow ?? [], options.env);
        let current = resumeFromNode !== undefined ? nodes.get(resumeFromNode) : nodes.get(workflow.initialNode);
        let transitionsTaken = 0;
        let lastActionResult: ActionResult | undefined;
        const iterationBound = workflow.iterationBound ?? 50;
        const defaultOnError = workflow.defaultOnError;
        let isResume = resumeFromNode !== undefined;

        if (current === undefined) {
            const label = resumeFromNode ?? workflow.initialNode;
            throw new FSMError(`Node "${label}" is not declared`);
        }

        while (true) {
            if (isResume) {
                // Resume: skip enter + node action on the first iteration (already ran before pause).
                isResume = false;
            } else {
                // 1. Persist current node snapshot before action execution.
                await lifecycle.enter(current.id, transitionsTaken);

                // 2. Execute the node action when one is configured (skipped in dry-run).
                if (options.dryRun) {
                    if (current.action !== undefined) {
                        lastActionResult = undefined;
                    }
                } else if (current.action !== undefined) {
                    const step = await runActionStep(current.action, vars, {
                        host: this.options.host,
                        persistence: this.options.persistence,
                        lifecycle,
                        workflowName: workflow.name,
                        stateOrNodeId: current.id,
                        runId,
                        mode: 'transition-flow',
                        transitionsTaken,
                        env,
                        options,
                        defaultOnError,
                    });
                    lastActionResult = step.result;
                    if (step.result?.setVars) vars = mergeSetVars(vars, step.result.setVars);
                    if (step.outcome === 'terminal') {
                        return await lifecycle.done(current.id, transitionsTaken);
                    }
                    if (step.outcome === 'fail') {
                        return await lifecycle.fail(current.id, transitionsTaken, step.result?.error);
                    }
                }

                // Pause: if the node declares pause, stop advancing and persist the paused position.
                if (current.pause === true) {
                    return await lifecycle.pause(current.id, transitionsTaken);
                }
            }

            // 3. Stop when the node is terminal or no outgoing edge exists.
            const outbound = workflow.edges.filter((edge) => edge.from === current?.id);
            if (terminal.has(current.id) || outbound.length === 0) {
                return await lifecycle.done(current.id, transitionsTaken);
            }

            // 4. Evaluate edge conditions in declaration order and pick the first passing edge.
            const edge = await firstPassingEdge(
                outbound,
                this.options.host,
                {
                    runId,
                    current: current.id,
                    vars,
                    lastActionResult,
                },
                lifecycle,
            );
            if (edge === undefined) {
                return await lifecycle.fail(current.id, transitionsTaken, 'no-passing-edge');
            }

            // 5. Persist the edge transition.
            transitionsTaken += 1;
            await lifecycle.recordTransition(current.id, edge.to, edge.condition?.kind ?? null);

            // 6. Enforce the iteration bound after taking the transition.
            if (transitionsTaken > iterationBound) {
                return await lifecycle.fail(current.id, transitionsTaken, 'iteration-bound-exceeded');
            }

            // 7. Move to the target node and repeat.
            const nextNode = nodes.get(edge.to);
            if (nextNode === undefined) throw new FSMError(`Edge target "${edge.to}" is not declared`);
            current = nextNode;
        }
    }
}

async function firstPassingEdge(
    edges: TransitionFlowWorkflowDef['edges'],
    host: WorkflowEngineHost,
    context: Parameters<WorkflowEngineHost['evaluateGuard']>[2],
    lifecycle: RunLifecycle,
): Promise<TransitionFlowWorkflowDef['edges'][number] | undefined> {
    for (const edge of edges) {
        if (edge.condition === undefined) return edge;
        // Resolve ${vars.*} templates in condition options before evaluation — conditions use
        // the same var interpolation as actions (symmetry with state-machine guard resolution).
        const resolvedOptions = resolveTemplates(edge.condition.options ?? {}, {
            vars: context.vars,
            env: {},
        });
        const passed = await host.evaluateGuard(edge.condition.kind, resolvedOptions, context);
        lifecycle.guardEvaluated(context.current, edge.to, edge.condition.kind, passed);
        if (passed) return edge;
    }
    return undefined;
}
