import type { WorkflowEngineHost } from './host';
import type {
    ActionResult,
    TransitionFlowWorkflowDef,
    WorkflowPersistenceAdapter,
    WorkflowRunOptions,
    WorkflowRunRecord,
    WorkflowRunResult,
} from './types';
import { mergeVars, resolveTemplates } from './variables';

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
        const runId = options.runId ?? crypto.randomUUID();
        const startedAt = new Date().toISOString();
        const mode = 'transition-flow';
        await this.options.persistence.createRun(runRecord(runId, workflow.name, mode, startedAt, options.metadata));

        const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
        const terminal = new Set(workflow.terminalNodes ?? []);
        const vars = mergeVars(workflow.vars, options.vars);
        const env = allowedEnv(workflow.env?.allow ?? [], options.env ?? process.env);
        let current = nodes.get(workflow.initialNode);
        let transitionsTaken = 0;
        let lastActionResult: ActionResult | undefined;
        const iterationBound = workflow.iterationBound ?? 50;

        if (current === undefined) {
            throw new Error(`Initial node "${workflow.initialNode}" is not declared`);
        }

        while (true) {
            // 1. Persist current node snapshot before action execution.
            await this.options.persistence.saveWorkflowState(runId, current.id, { transitionsTaken });
            await this.options.persistence.savePhase(runId, current.id, 'running');

            // 2. Execute the node action when one is configured.
            if (current.action !== undefined) {
                const resolved = resolveTemplates(current.action.options ?? {}, {
                    vars,
                    env,
                    builtins: { workflow: workflow.name, node: current.id, runId },
                });
                lastActionResult = await this.options.host.runAction(current.action.kind, resolved, {
                    runId,
                    workdir: options.workdir,
                    stateOrNodeId: current.id,
                    vars,
                    env,
                    metadata: options.metadata,
                });
                if (!lastActionResult.ok) {
                    return await this.fail(
                        runId,
                        workflow.name,
                        mode,
                        current.id,
                        transitionsTaken,
                        lastActionResult.error,
                    );
                }
                if (lastActionResult.terminal === true) {
                    return await this.done(runId, workflow.name, mode, current.id, transitionsTaken);
                }
            }

            // 3. Stop when the node is terminal or no outgoing edge exists.
            const outbound = workflow.edges.filter((edge) => edge.from === current?.id);
            if (terminal.has(current.id) || outbound.length === 0) {
                return await this.done(runId, workflow.name, mode, current.id, transitionsTaken);
            }

            // 4. Evaluate edge conditions in declaration order and pick the first passing edge.
            const edge = await firstPassingEdge(outbound, this.options.host, {
                runId,
                current: current.id,
                vars,
                lastActionResult,
            });
            if (edge === undefined) {
                return await this.fail(runId, workflow.name, mode, current.id, transitionsTaken, 'no-passing-edge');
            }

            // 5. Persist the edge transition.
            transitionsTaken += 1;
            await this.options.persistence.saveTransition(runId, current.id, edge.to, edge.condition?.kind ?? null);

            // 6. Enforce the iteration bound after taking the transition.
            if (transitionsTaken > iterationBound) {
                return await this.fail(
                    runId,
                    workflow.name,
                    mode,
                    current.id,
                    transitionsTaken,
                    'iteration-bound-exceeded',
                );
            }

            // 7. Move to the target node and repeat.
            const nextNode = nodes.get(edge.to);
            if (nextNode === undefined) throw new Error(`Edge target "${edge.to}" is not declared`);
            current = nextNode;
        }
    }

    private async done(
        runId: string,
        workflowName: string,
        mode: 'transition-flow',
        finalState: string,
        transitionsTaken: number,
    ): Promise<WorkflowRunResult> {
        await this.options.persistence.savePhase(runId, finalState, 'done');
        await this.options.persistence.finalizeRun(runId, 'done', new Date().toISOString());
        return { runId, workflowName, mode, status: 'done', finalState, transitionsTaken };
    }

    private async fail(
        runId: string,
        workflowName: string,
        mode: 'transition-flow',
        finalState: string,
        transitionsTaken: number,
        reason = 'failed',
    ): Promise<WorkflowRunResult> {
        await this.options.persistence.savePhase(runId, finalState, 'failed');
        await this.options.persistence.finalizeRun(runId, 'failed', new Date().toISOString());
        return { runId, workflowName, mode, status: 'failed', finalState, transitionsTaken, reason };
    }
}

async function firstPassingEdge(
    edges: TransitionFlowWorkflowDef['edges'],
    host: WorkflowEngineHost,
    context: Parameters<WorkflowEngineHost['evaluateGuard']>[2],
): Promise<TransitionFlowWorkflowDef['edges'][number] | undefined> {
    for (const edge of edges) {
        if (edge.condition === undefined) return edge;
        if (await host.evaluateGuard(edge.condition.kind, edge.condition.options ?? {}, context)) return edge;
    }
    return undefined;
}

function allowedEnv(names: readonly string[], source: Record<string, string | undefined>): Record<string, string> {
    return Object.fromEntries(
        names.flatMap((name) => (source[name] === undefined ? [] : [[name, source[name] as string]])),
    );
}

function runRecord(
    runId: string,
    workflowName: string,
    mode: string,
    startedAt: string,
    metadata: unknown,
): WorkflowRunRecord {
    return {
        id: runId,
        workflow_name: workflowName,
        mode,
        status: 'running',
        started_at: startedAt,
        completed_at: null,
        metadata_json: JSON.stringify(metadata ?? {}),
    };
}
