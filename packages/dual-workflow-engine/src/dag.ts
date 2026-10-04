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

        for (const node of workflow.nodes) {
            const deps = node.dependsOn ?? [];
            if (pausedNodeId && node.id === pausedNodeId) {
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
                            return { id: node.id, status: 'skipped' as const };
                        }
                    }

                    if (node.pause === true) {
                        nodeStatuses.set(node.id, 'paused');
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
                            return { id: node.id, status: 'failed' as const, error: step.result?.error ?? 'failed' };
                        }
                        if (step.result?.setVars) {
                            vars = mergeSetVars(vars, step.result.setVars);
                        }
                    }

                    nodeStatuses.set(node.id, 'done');
                    transitionsTaken++;
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

        return await lifecycle.done('dag', transitionsTaken);
    }
}
