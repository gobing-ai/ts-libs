import { runActionStep } from './action-step';
import { FSMError, WorkflowResumeError } from './errors';
import type { WorkflowEngineHost } from './host';
import { allowedEnv, RunLifecycle } from './run-lifecycle';
import type {
    DagNodeDef,
    DagWorkflowDef,
    Vars,
    WorkflowBranchRecord,
    WorkflowPersistenceAdapter,
    WorkflowResumeMode,
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
 * Stable topological order over declared nodes: repeatedly take the earliest
 * declared node whose dependencies are all placed (declaration order breaks
 * ties between equally ready nodes). Leftover nodes (validated-elsewhere
 * cycles) keep declaration order. Task 0104 Design 4.
 */
export function dagTopoOrder(nodes: readonly DagNodeDef[]): string[] {
    const placed: string[] = [];
    const placedIds = new Set<string>();
    const remaining = [...nodes];
    while (remaining.length > 0) {
        const nextIdx = remaining.findIndex((node) => (node.dependsOn ?? []).every((dep) => placedIds.has(dep)));
        if (nextIdx === -1) break;
        const node = remaining[nextIdx];
        remaining.splice(nextIdx, 1);
        if (node === undefined) break;
        placed.push(node.id);
        placedIds.add(node.id);
    }
    for (const node of remaining) placed.push(node.id);
    return placed;
}

/** Keep only string→string entries, mirroring mergeSetVars' defensive filter. */
function pickStringEntries(setVars: Vars): Vars {
    const accepted: Vars = {};
    for (const [key, value] of Object.entries(setVars)) {
        if (typeof value === 'string') accepted[key] = value;
    }
    return accepted;
}

/**
 * Parse one persisted branch delta (task 0104 Design 4). A null payload is an
 * empty legacy delta; malformed payloads fail loudly before any execution.
 */
function parseBranchDelta(raw: string | null, nodeId: string): Vars {
    if (raw === null) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new WorkflowResumeError(
            `DAG node "${nodeId}" has malformed persisted output: ${(error as Error).message}`,
        );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new WorkflowResumeError(`DAG node "${nodeId}" has malformed persisted output: expected an object`);
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== 'string') {
            throw new WorkflowResumeError(`DAG node "${nodeId}" persisted output "${key}" is not a string`);
        }
    }
    return parsed as Vars;
}

/**
 * Ledger-derived resume anchor for runs without a snapshot (task 0104 Design 1):
 * the first paused row in declaration order, otherwise the first unfinished
 * declared row, otherwise the first declared node.
 */
export function deriveDagResumeAnchor(
    nodes: readonly DagNodeDef[],
    statusByNode: ReadonlyMap<string, WorkflowBranchRecord['status']>,
): string | undefined {
    const firstPaused = nodes.find((node) => statusByNode.get(node.id) === 'paused')?.id;
    if (firstPaused !== undefined) return firstPaused;
    const firstUnfinished = nodes.find((node) => {
        const prior = statusByNode.get(node.id);
        return prior === 'running' || prior === 'pending';
    })?.id;
    if (firstUnfinished !== undefined) return firstUnfinished;
    return nodes[0]?.id;
}

/** Result of DAG resume admission checks (task 0104 Design 6). */
export interface DagResumeAdmission {
    /** Declared node naming where the resumed run logically continues from. */
    readonly anchor: string;
    /** Paused node whose acknowledgement this resume performs, if any. */
    readonly pausedTarget?: string;
}

/**
 * DAG-only resume admission (task 0104 Design 6). Checks every previously
 * unfinished (running/pending) action node: it may replay only under
 * rerun-enter with its own resumeRerun marker — never-started nodes need no
 * marker, done non-paused rows never replay. A paused anchor replays under
 * rerun-enter only with its marker; skip-enter is always safe (acknowledgement).
 * Exported for service.ts admission only — not part of the public package surface.
 */
export async function assertDagResumeAllowed(
    workflow: DagWorkflowDef,
    runId: string,
    persistence: WorkflowPersistenceAdapter,
    resumeMode: WorkflowResumeMode,
): Promise<DagResumeAdmission> {
    const rows = await persistence.listRunBranches(runId, DAG_LEDGER_NAMESPACE);
    const statusByNode = new Map(rows.map((row) => [row.branch_id, row.status]));

    for (const node of workflow.nodes) {
        const prior = statusByNode.get(node.id);
        if ((prior === 'running' || prior === 'pending') && node.action) {
            if (resumeMode !== 'rerun-enter' || node.resumeRerun !== true) {
                throw new FSMError(
                    `DAG node "${node.id}" has an unfinished action that is not marked resumeRerun: true — ` +
                        'replaying it requires resumeMode: "rerun-enter" and its own resumeRerun marker',
                );
            }
        }
    }

    const pausedTarget = workflow.nodes.find((node) => statusByNode.get(node.id) === 'paused')?.id;
    if (pausedTarget !== undefined && resumeMode === 'rerun-enter') {
        const target = workflow.nodes.find((node) => node.id === pausedTarget);
        if (target?.resumeRerun !== true) {
            throw new FSMError(
                `Cannot rerun-resume into "${pausedTarget}": not marked resumeRerun: true ` +
                    '(mark it safe to re-run — idempotent or deduped — or resume with resumeMode: "skip-enter")',
            );
        }
    }

    const snapshot = await persistence.loadLatestStateSnapshot(runId);
    const snapshotState = snapshot?.state;
    const anchor =
        (snapshotState !== undefined && statusByNode.has(snapshotState) ? snapshotState : undefined) ??
        deriveDagResumeAnchor(workflow.nodes, statusByNode);
    if (anchor === undefined) {
        throw new WorkflowResumeError(`Run "${runId}" cannot resume: the workflow declares no nodes`);
    }
    return { anchor, pausedTarget };
}

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
        // Task 0104 Design 6: direct driver resume is admission-checked too.
        // Resolve an absent resumeMode from the run's paused/interrupted status
        // (matching service.resumeRun's 0902 defaults) before dispatching.
        const resumeMode: WorkflowResumeMode =
            options.resumeMode ??
            ((await this.options.persistence.loadRun(runId))?.status === 'interrupted' ? 'rerun-enter' : 'skip-enter');
        await assertDagResumeAllowed(workflow, runId, this.options.persistence, resumeMode);
        return await RunLifecycle.resume(
            workflow.name,
            'dag',
            { persistence: this.options.persistence, events: options.events },
            runId,
            externalKey,
            (lifecycle) => this.loop(workflow, { ...options, resumeMode }, lifecycle),
            options.resumeOwner?.attemptId,
        );
    }

    private async loop(
        workflow: DagWorkflowDef,
        options: WorkflowRunOptions,
        lifecycle: RunLifecycle,
    ): Promise<WorkflowRunResult> {
        const runId = lifecycle.runId;
        const env = allowedEnv(workflow.env?.allow ?? [], options.env);
        const defaultOnError = workflow.defaultOnError;

        // Task 0104 Design 4: the per-node ledger is the recovery source. Settled
        // nodes keep their terminal status, terminal (done/paused) rows carry the
        // accepted string setVars delta via outputVars, and everything else
        // (running/pending rows, never-started nodes) re-enters via the deps rule.
        const snapshot = await this.options.persistence.loadLatestStateSnapshot(runId);
        const priorRows = await this.options.persistence.listRunBranches(runId, DAG_LEDGER_NAMESPACE);
        const rowByNode = new Map(priorRows.map((row) => [row.branch_id, row]));

        const nodeStatuses = new Map<string, DagNodeStatus>();
        const nodeDeltas = new Map<string, Vars>();
        let transitionsTaken = 0; // task 0104 Design 5: distinct completed nodes, recounted from the ledger
        for (const node of workflow.nodes) {
            const deps = node.dependsOn ?? [];
            const prior = rowByNode.get(node.id);
            const priorStatus = prior?.status;
            if (priorStatus === 'done') {
                nodeStatuses.set(node.id, 'done');
                transitionsTaken++;
                nodeDeltas.set(node.id, parseBranchDelta(prior?.output_vars_json ?? null, node.id));
            } else if (priorStatus === 'paused') {
                nodeStatuses.set(node.id, 'paused');
                transitionsTaken++;
                nodeDeltas.set(node.id, parseBranchDelta(prior?.output_vars_json ?? null, node.id));
            } else if (priorStatus === 'cancelled') {
                nodeStatuses.set(node.id, 'skipped');
            } else if (priorStatus === 'failed') {
                nodeStatuses.set(node.id, 'failed');
            } else {
                nodeStatuses.set(node.id, deps.length === 0 ? 'ready' : 'pending');
            }
        }

        // Terminal deltas merge in stable topological order (task 0104 Design 4):
        // declared order among equally ready nodes, so collisions resolve
        // deterministically. Precedence: workflow defaults → snapshot baseline →
        // ledger deltas → caller options.vars.
        let ledgerDelta: Vars = {};
        for (const nodeId of dagTopoOrder(workflow.nodes)) {
            const delta = nodeDeltas.get(nodeId);
            if (delta !== undefined) ledgerDelta = mergeVars(ledgerDelta, delta);
        }
        // 1. workflow defaults → 2. snapshot baseline → 3. ledger deltas → 4. caller.
        let vars = workflow.vars ?? {};
        if (snapshot?.data?.effectiveVars && typeof snapshot.data.effectiveVars === 'object') {
            vars = mergeVars(vars, snapshot.data.effectiveVars as Vars);
        }
        vars = mergeVars(vars, ledgerDelta);
        vars = mergeVars(vars, options.vars);
        // Task 0104 Design 1: persist a ledger-derived anchor so a crash right
        // after the ownership claim still leaves a recoverable checkpoint. Fresh
        // runs anchor at the first declared node; interrupted runs without a
        // snapshot derive their anchor from the ledger (after the CAS).
        if (!options.dryRun && snapshot === undefined && workflow.nodes.length > 0) {
            const declaredAnchor = workflow.nodes[0]?.id;
            const anchor =
                priorRows.length > 0
                    ? deriveDagResumeAnchor(workflow.nodes, new Map(priorRows.map((r) => [r.branch_id, r.status])))
                    : declaredAnchor;
            if (anchor !== undefined) {
                await this.options.persistence.saveWorkflowState(runId, anchor, {
                    effectiveVars: vars,
                    transitionsTaken,
                });
            }
        }

        // Task 0104 Design 7: acknowledge exactly one paused node before the wave
        // loop. The target is the snapshot anchor when it names a paused row,
        // otherwise the first paused row in declaration order (interrupted recovery).
        const snapshotState = snapshot?.state;
        let pausedTarget: string | undefined;
        if (snapshotState !== undefined && rowByNode.get(snapshotState)?.status === 'paused') {
            pausedTarget = snapshotState;
        } else {
            pausedTarget = workflow.nodes.find((node) => rowByNode.get(node.id)?.status === 'paused')?.id;
        }
        let rerunPauseBypass: string | undefined;
        if (pausedTarget !== undefined) {
            const targetNode = workflow.nodes.find((node) => node.id === pausedTarget);
            if (options.resumeMode === 'rerun-enter') {
                if (targetNode?.resumeRerun !== true) {
                    throw new FSMError(
                        `Cannot rerun-resume into "${pausedTarget}": not marked resumeRerun: true ` +
                            '(mark it safe to re-run — idempotent or deduped — or resume with resumeMode: "skip-enter")',
                    );
                }
                rerunPauseBypass = pausedTarget;
                nodeStatuses.set(pausedTarget, 'ready');
            } else {
                // skip-enter: the paused action is accepted as complete — settle its
                // row done with the existing delta before allowing dependents.
                if (!options.dryRun) {
                    await this.options.persistence.saveBranchFinalize(
                        runId,
                        pausedTarget,
                        'done',
                        0,
                        nodeDeltas.get(pausedTarget),
                    );
                }
                nodeStatuses.set(pausedTarget, 'done');
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

        let failureError: string | undefined;

        // Task 0105: completion-driven admission replaces fixed waves. A newly
        // eligible child is admitted as soon as its prerequisites' entire node
        // promises (condition → action → audit → terminal branch write) settle —
        // not when an unrelated in-flight sibling settles. Loop-local state only.
        type NodeStepResult = { id: string; status: 'done' | 'failed' | 'paused' | 'skipped'; error?: string };
        type NodeOutcome =
            | { kind: 'fulfilled'; id: string; index: number; result: NodeStepResult }
            | { kind: 'rejected'; id: string; index: number; reason: unknown };
        const inFlight = new Map<string, { index: number; tracking: Promise<void> }>();
        const settlements: NodeOutcome[] = [];
        const outcomes: (NodeOutcome | undefined)[] = new Array(workflow.nodes.length).fill(undefined);
        let stopAdmission = false;
        let coordinatorCaught = false;
        let coordinatorError: unknown;

        // Whole-node execution. Readiness publishes only when this promise
        // settles, so a successful host return alone never dispatches a child.
        const executeNode = async (node: DagNodeDef): Promise<NodeStepResult> => {
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

            // Task 0104 Design 8: the ordinary pause check moved after action
            // execution — a pause node with an action completes the action and
            // its audit chain first, persists its accepted delta as a 'paused'
            // row, and only then surfaces the pause result. Fail outcomes and
            // thrown guard/persistence exceptions still outrank pause.
            const isPauseNode = node.pause === true && node.id !== rerunPauseBypass;

            let acceptedDelta: Vars | undefined;
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
                    acceptedDelta = pickStringEntries(step.result.setVars);
                }
            }

            // Task 0104 R1: persist the accepted string setVars delta through
            // outputVars so dependent resumes recover produced variables even
            // without a snapshot. No-action nodes store an empty delta.
            nodeStatuses.set(node.id, 'done');
            // A node re-executed after pause/rerun admission was already
            // counted from its ledger row — never count it twice.
            if (!nodeDeltas.has(node.id)) transitionsTaken++;
            if (!options.dryRun) {
                await this.options.persistence.saveBranchFinalize(
                    runId,
                    node.id,
                    isPauseNode ? 'paused' : 'done',
                    Date.now() - nodeStartMs,
                    acceptedDelta,
                );
            }
            if (isPauseNode) {
                nodeStatuses.set(node.id, 'paused');
                return { id: node.id, status: 'paused' as const };
            }
            return { id: node.id, status: 'done' as const };
        };

        const admit = (node: DagNodeDef, index: number): void => {
            // Synchronous reservation before any await: exactly-once admission.
            nodeStatuses.set(node.id, 'running');
            const tracking = executeNode(node).then(
                (result) => {
                    settlements.push({ kind: 'fulfilled', id: node.id, index, result });
                    if (result.status === 'failed' || result.status === 'paused') stopAdmission = true;
                },
                (reason) => {
                    // The observer swallows the rejection; the discriminator
                    // carries it (never filter by truthiness). No raw
                    // rejection is ever left unobserved.
                    settlements.push({ kind: 'rejected', id: node.id, index, reason });
                    stopAdmission = true;
                },
            );
            inFlight.set(node.id, { index, tracking });
        };

        const consumeSettlements = (): void => {
            while (settlements.length > 0) {
                const outcome = settlements.shift();
                if (outcome === undefined) continue;
                inFlight.delete(outcome.id);
                outcomes[outcome.index] = outcome;
            }
        };

        const drainInFlight = async (): Promise<void> => {
            if (inFlight.size > 0) {
                await Promise.allSettled(Array.from(inFlight.values()).map((entry) => entry.tracking));
            }
            consumeSettlements();
        };

        try {
            while (true) {
                if (stopAdmission) {
                    // Terminal outcome observed: admit nothing new; every admitted
                    // node's full chain settles before routing (drain barrier).
                    await drainInFlight();
                    break;
                }
                consumeSettlements();

                // Readiness + skip propagation to a fixed point (declaration
                // order), so backward-declared all-skipped chains settle.
                let changed = true;
                while (changed) {
                    changed = false;
                    for (const [index, node] of workflow.nodes.entries()) {
                        const status = nodeStatuses.get(node.id);
                        if (status === 'ready') {
                            admit(node, index);
                            changed = true;
                        } else if (status === 'pending') {
                            const check = checkDependenciesSatisfied(node);
                            if (check.shouldSkip) {
                                nodeStatuses.set(node.id, 'skipped');
                                changed = true;
                            } else if (check.ready) {
                                admit(node, index);
                                changed = true;
                            }
                        }
                    }
                }
                if (stopAdmission) continue;
                if (inFlight.size === 0) break;
                // Race is notification only — routing happens at the loop top,
                // after re-checking the queue and the stop flag, so simultaneous
                // fatal outcomes cannot be bypassed by a success.
                await Promise.race(Array.from(inFlight.values()).map((entry) => entry.tracking));
            }
        } catch (error) {
            // Coordinator/checkpoint exception: drain admitted work, retain its
            // outcomes, and let unified routing below compose the reasons.
            coordinatorCaught = true;
            coordinatorError = error;
            await drainInFlight();
        }

        // Task 0103 R2 contract on the completion-driven scheduler: node
        // exceptions outrank fulfilled fail-policy results, which outrank
        // pauses. Outcomes are retained by declaration index, so iteration
        // order IS declaration order.
        const nodeReasons: unknown[] = [];
        for (const outcome of outcomes) {
            if (outcome === undefined) continue;
            if (outcome.kind === 'rejected') nodeReasons.push(outcome.reason);
            else if (outcome.result.status === 'failed') failureError = outcome.result.error;
        }
        if (nodeReasons.length === 1 && !coordinatorCaught) {
            throw nodeReasons[0];
        }
        if (nodeReasons.length > 0 || coordinatorCaught) {
            const reasons = [...nodeReasons];
            if (coordinatorCaught) reasons.push(coordinatorError);
            throw new AggregateError(reasons, 'DAG node execution failed');
        }

        // Final completion check
        const anyFailed = Array.from(nodeStatuses.values()).some((s) => s === 'failed');
        if (anyFailed) {
            return await lifecycle.fail('dag', transitionsTaken, failureError ?? 'dag-failed');
        }

        // Task 0104 Design 7: paused rows other than the acknowledged target stay
        // barriers — surface the next outstanding pause (declaration order) once
        // admitted work has drained, instead of reporting done early.
        const nextPaused = workflow.nodes.find((node) => nodeStatuses.get(node.id) === 'paused');
        if (nextPaused !== undefined) {
            return await lifecycle.pause(nextPaused.id, transitionsTaken, vars);
        }

        // Never report done while a node is stranded (task 0101 R3): unreachable = loud failure.
        const stuck = workflow.nodes.filter((n) => nodeStatuses.get(n.id) === 'pending').map((n) => n.id);
        if (stuck.length > 0) {
            return await lifecycle.fail('dag', transitionsTaken, `dag-unreachable-nodes: ${stuck.join(',')}`);
        }

        return await lifecycle.done('dag', transitionsTaken);
    }
}
