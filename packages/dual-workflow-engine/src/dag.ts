import { runActionStep } from './action-step';
import type { WorkflowEngineHost } from './host';
import { allowedEnv, RunLifecycle, snapshotTransitions } from './run-lifecycle';
import type {
    DagNodeDef,
    DagWorkflowDef,
    Vars,
    WorkflowPersistenceAdapter,
    WorkflowRunOptions,
    WorkflowRunResult,
} from './types';
import { mergeSetVars, mergeVars, resolveShellCommandTemplates, resolveTemplates } from './variables';

/** Dependencies required by the static dependency DAG driver. */
export interface DagDriverOptions {
    readonly host: WorkflowEngineHost;
    readonly persistence: WorkflowPersistenceAdapter;
}

/** Execution status of a single DAG node within a run. */
export type DagNodeStatus = 'pending' | 'ready' | 'running' | 'done' | 'failed' | 'skipped' | 'paused';

// Reserved parallel_node namespace reusing the 0094 branch ledger for per-node DAG execution records.
const DAG_LEDGER_NAMESPACE = '__dag__';

/**
 * Static dependency DAG workflow driver (task 0100, ADR-034).
 * Manages an in-process ready queue of runnable nodes, dispatching them as upstream
 * dependencies complete, propagating skips on conditional branches, and supporting
 * pause, resume, and durable recovery.
 */
export class DagDriver {
    constructor(private readonly options: DagDriverOptions) {}

    /** Run a DAG workflow to completion, pause, or failure. */
    async run(workflow: DagWorkflowDef, options: WorkflowRunOptions = {}): Promise<WorkflowRunResult> {
        return await RunLifecycle.run(
            workflow.name,
            'dag',
            { persistence: this.options.persistence, events: options.events },
            options,
            (lifecycle) => this.loop(workflow, options, lifecycle),
        );
    }

    /** Resume a paused DAG workflow run. */
    async resume(
        workflow: DagWorkflowDef,
        runId: string,
        externalKey: string | undefined,
        options: WorkflowRunOptions = {},
    ): Promise<WorkflowRunResult> {
        return await RunLifecycle.resume(
            workflow.name,
            'dag',
            { persistence: this.options.persistence, events: options.events },
            runId,
            externalKey,
            (lifecycle) => this.loop(workflow, options, lifecycle),
            options.resumeOwner?.attemptId,
        );
    }

    private async loop(
        workflow: DagWorkflowDef,
        options: WorkflowRunOptions,
        lifecycle: RunLifecycle,
    ): Promise<WorkflowRunResult> {
        const runId = lifecycle.runId;
        let vars = mergeVars(workflow.vars, options.vars);
        const env = allowedEnv(workflow.env?.allow ?? [], options.env);
        const defaultOnError = workflow.defaultOnError;

        // Restore snapshot if resuming
        const snapshot = await this.options.persistence.loadLatestStateSnapshot(runId);
        let transitionsTaken = snapshotTransitions(snapshot?.data);
        if (snapshot?.data?.effectiveVars && typeof snapshot.data.effectiveVars === 'object') {
            vars = mergeVars(vars, snapshot.data.effectiveVars as Vars);
        }

        const nodeStatuses = new Map<string, DagNodeStatus>();
        // If resuming, determine if any node was already paused or completed
        const pausedNodeId = snapshot?.state;

        // Seed from the durable per-node ledger (task 0101): settled nodes are never
        // re-dispatched. 'cancelled' rows are condition-skipped nodes; 'paused'/'running'/
        // 'pending' rows fall through to the dependsOn rule so interrupted nodes re-run.
        const priorRows = await this.options.persistence.listRunBranches(runId, DAG_LEDGER_NAMESPACE);
        const priorByNode = new Map(priorRows.map((r) => [r.branch_id, r.status]));

        for (const node of workflow.nodes) {
            const deps = node.dependsOn ?? [];
            const prior = priorByNode.get(node.id);
            if (prior === 'done') {
                nodeStatuses.set(node.id, 'done');
            } else if (prior === 'cancelled') {
                nodeStatuses.set(node.id, 'skipped');
            } else if (prior === 'failed') {
                nodeStatuses.set(node.id, 'failed');
            } else if (pausedNodeId && node.id === pausedNodeId) {
                nodeStatuses.set(node.id, 'done');
            } else {
                nodeStatuses.set(node.id, deps.length === 0 ? 'ready' : 'pending');
            }
        }

        const checkDependenciesSatisfied = (node: DagNodeDef): { ready: boolean; shouldSkip: boolean } => {
            const deps = node.dependsOn ?? [];
            if (deps.length === 0) return { ready: true, shouldSkip: false };

            const policy = node.dependencyPolicy ?? 'all';
            const depStatuses = deps.map((d) => nodeStatuses.get(d) ?? 'pending');

            if (policy === 'any') {
                const anyDone = depStatuses.some((s) => s === 'done');
                if (anyDone) return { ready: true, shouldSkip: false };
                const allSettled = depStatuses.every((s) => s === 'done' || s === 'skipped' || s === 'failed');
                const allSkipped = depStatuses.every((s) => s === 'skipped');
                return { ready: false, shouldSkip: allSettled && allSkipped };
            }

            // policy === 'all'
            const allDone = depStatuses.every((s) => s === 'done');
            if (allDone) return { ready: true, shouldSkip: false };

            // Skip propagation: if all parents have settled, and none failed, but some are skipped
            const allSettled = depStatuses.every((s) => s === 'done' || s === 'skipped');
            const hasSkipped = depStatuses.some((s) => s === 'skipped');
            if (allSettled && hasSkipped) {
                // If every dependent branch was skipped, skip this node too
                const allSkipped = depStatuses.every((s) => s === 'skipped');
                if (allSkipped) {
                    return { ready: false, shouldSkip: true };
                }
                // If some are done and some are skipped, join proceeds with completed branches!
                return { ready: true, shouldSkip: false };
            }

            return { ready: false, shouldSkip: false };
        };

        let pausedNode: string | undefined;
        let failureError: string | undefined;

        while (true) {
            // Find nodes ready to run
            const readyNodes: DagNodeDef[] = [];
            for (const node of workflow.nodes) {
                const status = nodeStatuses.get(node.id);
                if (status === 'pending') {
                    const check = checkDependenciesSatisfied(node);
                    if (check.shouldSkip) {
                        nodeStatuses.set(node.id, 'skipped');
                    } else if (check.ready) {
                        nodeStatuses.set(node.id, 'ready');
                        readyNodes.push(node);
                    }
                } else if (status === 'ready') {
                    readyNodes.push(node);
                }
            }

            if (readyNodes.length === 0) {
                break;
            }

            // Dispatch ready nodes concurrently
            const results = await Promise.all(
                readyNodes.map(async (node) => {
                    nodeStatuses.set(node.id, 'running');
                    // Ledger rows make per-node completion durable; dryRun executes nothing and records nothing.
                    const nodeStartMs = Date.now();
                    if (!options.dryRun) {
                        await this.options.persistence.saveBranchStart(runId, DAG_LEDGER_NAMESPACE, node.id, node.id);
                    }

                    // Check condition if declared
                    if (node.condition) {
                        const resolvedOptions =
                            node.condition.kind === 'shell'
                                ? resolveShellCommandTemplates(node.condition.options ?? {}, { vars, env })
                                : resolveTemplates(node.condition.options ?? {}, { vars, env });
                        const passed = await this.options.host.evaluateGuard(node.condition.kind, resolvedOptions, {
                            runId,
                            current: node.id,
                            vars,
                            env,
                            workdir: options.workdir,
                        });
                        if (!passed) {
                            nodeStatuses.set(node.id, 'skipped');
                            // BranchStatus has no 'skipped'; 'cancelled' marks settled-without-running.
                            if (!options.dryRun) {
                                await this.options.persistence.saveBranchFinalize(
                                    runId,
                                    node.id,
                                    'cancelled',
                                    Date.now() - nodeStartMs,
                                );
                            }
                            return { id: node.id, status: 'skipped' as const };
                        }
                    }

                    if (node.pause === true) {
                        nodeStatuses.set(node.id, 'paused');
                        if (!options.dryRun) {
                            await this.options.persistence.saveBranchFinalize(
                                runId,
                                node.id,
                                'paused',
                                Date.now() - nodeStartMs,
                            );
                        }
                        return { id: node.id, status: 'paused' as const };
                    }

                    if (!options.dryRun && node.action) {
                        const step = await runActionStep(node.action, vars, {
                            host: this.options.host,
                            persistence: this.options.persistence,
                            lifecycle,
                            workflowName: workflow.name,
                            stateOrNodeId: node.id,
                            runId,
                            mode: 'dag',
                            transitionsTaken,
                            env,
                            options,
                            defaultOnError,
                        });
                        if (step.outcome === 'fail') {
                            nodeStatuses.set(node.id, 'failed');
                            if (!options.dryRun) {
                                await this.options.persistence.saveBranchFinalize(
                                    runId,
                                    node.id,
                                    'failed',
                                    Date.now() - nodeStartMs,
                                    undefined,
                                    step.result?.error ?? 'failed',
                                );
                            }
                            return { id: node.id, status: 'failed' as const, error: step.result?.error ?? 'failed' };
                        }
                        if (step.result?.setVars) {
                            vars = mergeSetVars(vars, step.result.setVars);
                        }
                    }

                    nodeStatuses.set(node.id, 'done');
                    transitionsTaken++;
                    if (!options.dryRun) {
                        await this.options.persistence.saveBranchFinalize(
                            runId,
                            node.id,
                            'done',
                            Date.now() - nodeStartMs,
                        );
                    }
                    return { id: node.id, status: 'done' as const };
                }),
            );

            // Check if any failed or paused
            for (const res of results) {
                if (res.status === 'failed') {
                    failureError = res.error;
                } else if (res.status === 'paused') {
                    pausedNode = res.id;
                }
            }

            if (failureError) {
                return await lifecycle.fail('dag', transitionsTaken, failureError);
            }

            if (pausedNode) {
                return await lifecycle.pause(pausedNode, transitionsTaken, vars);
            }
        }

        // Final completion check
        const anyFailed = Array.from(nodeStatuses.values()).some((s) => s === 'failed');
        if (anyFailed) {
            return await lifecycle.fail('dag', transitionsTaken, failureError ?? 'dag-failed');
        }

        // Never report done while a node is stranded (task 0101 R3): unreachable = loud failure.
        const stuck = workflow.nodes.filter((n) => nodeStatuses.get(n.id) === 'pending').map((n) => n.id);
        if (stuck.length > 0) {
            return await lifecycle.fail('dag', transitionsTaken, `dag-unreachable-nodes: ${stuck.join(',')}`);
        }

        return await lifecycle.done('dag', transitionsTaken);
    }
}
