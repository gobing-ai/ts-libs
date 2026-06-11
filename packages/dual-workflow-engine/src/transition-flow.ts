import { FSMError } from './errors';
import type { WorkflowEngineHost } from './host';
import { allowedEnv, RunLifecycle, runtimeBuiltins } from './run-lifecycle';
import type {
    ActionResult,
    TransitionFlowWorkflowDef,
    WorkflowPersistenceAdapter,
    WorkflowRunOptions,
    WorkflowRunResult,
} from './types';
import { mergeSetVars, mergeVars, resolveOnErrorPolicy, resolveTemplates } from './variables';

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

    private async loop(
        workflow: TransitionFlowWorkflowDef,
        options: WorkflowRunOptions,
        lifecycle: RunLifecycle,
    ): Promise<WorkflowRunResult> {
        const runId = lifecycle.runId;
        const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
        const terminal = new Set(workflow.terminalNodes ?? []);
        let vars = mergeVars(workflow.vars, options.vars);
        const env = allowedEnv(workflow.env?.allow ?? [], options.env);
        let current = nodes.get(workflow.initialNode);
        let transitionsTaken = 0;
        let lastActionResult: ActionResult | undefined;
        const iterationBound = workflow.iterationBound ?? 50;
        const defaultOnError = workflow.defaultOnError;

        if (current === undefined) {
            throw new FSMError(`Initial node "${workflow.initialNode}" is not declared`);
        }

        while (true) {
            // 1. Persist current node snapshot before action execution.
            await lifecycle.enter(current.id, transitionsTaken);

            // 2. Execute the node action when one is configured (skipped in dry-run).
            if (options.dryRun) {
                if (current.action !== undefined) {
                    lastActionResult = undefined;
                }
            } else if (current.action !== undefined) {
                const resolved = resolveTemplates(current.action.options ?? {}, {
                    vars,
                    env,
                    builtins: runtimeBuiltins(workflow.name, current.id, runId, transitionsTaken, 'transition-flow'),
                });
                const actionId = await this.options.persistence.saveActionStart(runId, current.id, current.action.kind);
                const actionStartMs = Date.now();
                lifecycle.actionStart(current.id, current.action.kind);
                try {
                    lastActionResult = await this.options.host.runAction(current.action.kind, resolved, {
                        runId,
                        workdir: options.workdir,
                        stateOrNodeId: current.id,
                        vars,
                        env,
                        metadata: options.metadata,
                        events: options.events,
                    });
                } finally {
                    const durationMs = Date.now() - actionStartMs;
                    lifecycle.actionDone(current.id, current.action.kind, durationMs, lastActionResult?.ok ?? false);
                    void this.options.persistence.saveActionFinalize(
                        actionId,
                        lastActionResult?.ok !== false ? 'done' : 'failed',
                        durationMs,
                        lastActionResult?.ok ?? false,
                        lastActionResult,
                    );
                }
                if (lastActionResult.setVars) vars = mergeSetVars(vars, lastActionResult.setVars);
                if (!lastActionResult.ok) {
                    const policy = resolveOnErrorPolicy(current.action.onError, defaultOnError, options.onError);
                    if (policy === 'fail') {
                        return await lifecycle.fail(current.id, transitionsTaken, lastActionResult.error);
                    }
                    lifecycle.warnActionFailed(current.id, transitionsTaken, lastActionResult.error);
                }
                if (lastActionResult.terminal === true) {
                    return await lifecycle.done(current.id, transitionsTaken);
                }
            }

            // 3. Stop when the node is terminal or no outgoing edge exists.
            const outbound = workflow.edges.filter((edge) => edge.from === current?.id);
            if (terminal.has(current.id) || outbound.length === 0) {
                return await lifecycle.done(current.id, transitionsTaken);
            }

            // 4. Evaluate edge conditions in declaration order and pick the first passing edge.
            const edge = await firstPassingEdge(outbound, this.options.host, {
                runId,
                current: current.id,
                vars,
                lastActionResult,
            }, lifecycle);
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
        const passed = await host.evaluateGuard(edge.condition.kind, edge.condition.options ?? {}, context);
        lifecycle.guardEvaluated(context.current, edge.to, edge.condition.kind, passed);
        if (passed) return edge;
    }
    return undefined;
}
