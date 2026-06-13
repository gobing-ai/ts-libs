import { addSpanEvent, type EventBus, getLogger, type Logger, traceAsync } from '@gobing-ai/ts-infra';
import { getProcessEnv } from '@gobing-ai/ts-runtime';
import type { WorkflowEngineEvents } from './events';
import type {
    WorkflowPersistenceAdapter,
    WorkflowRunOptions,
    WorkflowRunRecord,
    WorkflowRunResult,
    WorkflowStatus,
} from './types';

/** Workflow dialect carried on every run, span, and persisted record. */
export type WorkflowMode = WorkflowRunResult['mode'];

/** Keys of the runtime builtin namespace, single-sourced for resolver + validator. */
export const RUNTIME_BUILTIN_KEYS = [
    'workflow',
    'runId',
    'task',
    'state',
    'node',
    'iteration',
    'run',
    'runtime',
] as const;

/** Built-in bare template values available to action options (state-machine + transition-flow). */
export function runtimeBuiltins(
    workflowName: string,
    stateOrNodeId: string,
    runId: string,
    transitionsTaken: number,
    mode: WorkflowMode,
): Record<(typeof RUNTIME_BUILTIN_KEYS)[number], string | number> {
    return {
        workflow: workflowName,
        runId,
        task: workflowName,
        state: stateOrNodeId,
        node: stateOrNodeId,
        iteration: transitionsTaken,
        run: runId,
        runtime: mode,
    };
}

/** Project the env allowlist over a source map, dropping unset names. */
export function allowedEnv(
    names: readonly string[],
    source: Record<string, string | undefined> = getProcessEnv(),
): Record<string, string> {
    return Object.fromEntries(
        names.flatMap((name) => (source[name] === undefined ? [] : [[name, source[name] as string]])),
    );
}

/** Dependencies a driver hands to {@link RunLifecycle}. */
export interface RunLifecycleDeps {
    readonly persistence: WorkflowPersistenceAdapter;
    /** Observability sink; defaults to the shared `workflow` category logger. */
    readonly logger?: Logger;
    /** Optional event bus for structured in-process run observability. */
    readonly events?: EventBus<WorkflowEngineEvents>;
}

/**
 * Owns the run-level bookkeeping shared by both drivers: run identity, the
 * create→phase→finalize persistence sequence, and observability (one OTel span
 * per run plus structured log lines). The two driver control loops stay
 * dialect-specific (ADR-006 §7) and call into this for every persistence touch.
 */
export class RunLifecycle {
    readonly runId: string;
    private readonly persistence: WorkflowPersistenceAdapter;
    private readonly events: EventBus<WorkflowEngineEvents> | undefined;
    private readonly logger: Logger;

    private constructor(
        runId: string,
        private readonly workflowName: string,
        private readonly mode: WorkflowMode,
        deps: RunLifecycleDeps,
    ) {
        this.runId = runId;
        this.persistence = deps.persistence;
        this.events = deps.events;
        this.logger = (deps.logger ?? getLogger('workflow')).child({ runId, workflow: workflowName, mode });
    }

    /**
     * Create the run record and execute `loop` inside the run's OTel span. The
     * driver's control loop is the body; it receives this lifecycle to drive
     * per-step persistence and terminal results.
     */
    static async run(
        workflowName: string,
        mode: WorkflowMode,
        deps: RunLifecycleDeps,
        options: WorkflowRunOptions,
        loop: (lifecycle: RunLifecycle) => Promise<WorkflowRunResult>,
    ): Promise<WorkflowRunResult> {
        return await traceAsync(
            'workflow.run',
            async () => {
                const startedAt = new Date().toISOString();
                const proposed = RunLifecycle.runRecord(
                    options.runId ?? crypto.randomUUID(),
                    workflowName,
                    mode,
                    startedAt,
                    options.metadata,
                    options.externalKey,
                );
                let record = proposed;
                if (options.externalKey === undefined) {
                    await deps.persistence.createRun(proposed);
                } else {
                    record = await deps.persistence.createOrAttachRun(proposed);
                }
                const lifecycle = new RunLifecycle(record.id, workflowName, mode, deps);
                lifecycle.logger.info('workflow run started');
                addSpanEvent('workflow.run.started', {
                    workflowName,
                    mode,
                    runId: lifecycle.runId,
                    dryRun: options.dryRun ?? false,
                });
                void lifecycle.events?.emit('workflow.run.started', {
                    workflowName,
                    mode,
                    runId: lifecycle.runId,
                    dryRun: options.dryRun ?? false,
                });
                return await loop(lifecycle);
            },
            { attributes: { 'workflow.name': workflowName, 'workflow.mode': mode } },
        );
    }

    /** Persist the current state/node snapshot and mark its phase running. */
    async enter(stateOrNodeId: string, transitionsTaken: number): Promise<void> {
        await this.persistence.saveWorkflowState(this.runId, stateOrNodeId, { transitionsTaken });
        await this.persistence.savePhase(this.runId, stateOrNodeId, 'running');
        addSpanEvent('workflow.node.enter', {
            runId: this.runId,
            node: stateOrNodeId,
            transitionsTaken,
        });
        void this.events?.emit('workflow.node.enter', {
            runId: this.runId,
            node: stateOrNodeId,
            transitionsTaken,
        });
    }

    /** Persist a transition and emit its observability event. */
    async recordTransition(from: string, to: string, trigger: string | null): Promise<void> {
        await this.persistence.saveTransition(this.runId, from, to, trigger);
        addSpanEvent('workflow.node.transition', {
            runId: this.runId,
            from,
            to,
            ...(trigger === null ? {} : { trigger }),
        });
        void this.events?.emit('workflow.node.transition', {
            runId: this.runId,
            from,
            to,
            trigger,
        });
    }

    /** Finalize the run as succeeded and return its result. */
    async done(finalState: string, transitionsTaken: number): Promise<WorkflowRunResult> {
        await this.persistence.savePhase(this.runId, finalState, 'done');
        await this.persistence.finalizeRun(this.runId, 'done', new Date().toISOString());
        this.logger.info('workflow run done', { finalState, transitionsTaken });
        addSpanEvent('workflow.run.done', { runId: this.runId, finalState, transitionsTaken });
        void this.events?.emit('workflow.run.done', { runId: this.runId, finalState, transitionsTaken });
        return this.result('done', finalState, transitionsTaken);
    }

    /** Finalize the run as failed and return its result. */
    async fail(finalState: string, transitionsTaken: number, reason = 'failed'): Promise<WorkflowRunResult> {
        await this.persistence.savePhase(this.runId, finalState, 'failed');
        await this.persistence.finalizeRun(this.runId, 'failed', new Date().toISOString());
        addSpanEvent('workflow.run.failed', { runId: this.runId, finalState, reason });
        void this.events?.emit('workflow.run.failed', { runId: this.runId, finalState, reason });
        this.logger.warn('workflow run failed', { finalState, transitionsTaken, reason });
        return this.result('failed', finalState, transitionsTaken, reason);
    }

    /** Emit action-level observability before a host action is invoked. */
    actionStart(stateOrNodeId: string, kind: string): void {
        addSpanEvent('workflow.action.start', { runId: this.runId, node: stateOrNodeId, kind });
        void this.events?.emit('workflow.action.start', { runId: this.runId, node: stateOrNodeId, kind });
    }

    /** Emit action-level observability after a host action settles. */
    actionDone(stateOrNodeId: string, kind: string, durationMs: number, ok: boolean): void {
        addSpanEvent('workflow.action.done', { runId: this.runId, node: stateOrNodeId, kind, durationMs, ok });
        void this.events?.emit('workflow.action.done', {
            runId: this.runId,
            node: stateOrNodeId,
            kind,
            durationMs,
            ok,
        });
    }

    /** Log and trace a non-fatal action failure for the 'continue' error policy (ADR-013 observability seam). */
    warnActionFailed(stateOrNodeId: string, transitionsTaken: number, error?: string): void {
        addSpanEvent('workflow.action.failed_continue', {
            runId: this.runId,
            node: stateOrNodeId,
            transitionsTaken,
            ...(error === undefined ? {} : { error }),
        });
        void this.events?.emit('workflow.action.failed_continue', {
            runId: this.runId,
            node: stateOrNodeId,
            transitionsTaken,
            ...(error === undefined ? {} : { error }),
        });
        this.logger.warn('action failed (continuing)', { node: stateOrNodeId, transitionsTaken, error });
    }

    /** Emit a guard evaluation result (fired for every guard, including rejected). */
    guardEvaluated(from: string, to: string, kind: string, passed: boolean): void {
        void this.events?.emit('workflow.guard.evaluated', {
            runId: this.runId,
            from,
            to,
            kind,
            passed,
        });
    }

    /** Emit when an interactive HITL prompt is presented. */
    hitlAsk(node: string, kind: string, message: string): void {
        void this.events?.emit('workflow.hitl.ask', { runId: this.runId, node, kind, message });
    }

    /** Emit when an interactive HITL prompt resolves. */
    hitlResponse(node: string, ok: boolean): void {
        void this.events?.emit('workflow.hitl.response', { runId: this.runId, node, ok });
    }

    private result(
        status: WorkflowStatus,
        finalState: string,
        transitionsTaken: number,
        reason?: string,
    ): WorkflowRunResult {
        return {
            runId: this.runId,
            workflowName: this.workflowName,
            mode: this.mode,
            status,
            finalState,
            transitionsTaken,
            ...(reason === undefined ? {} : { reason }),
        };
    }

    private static runRecord(
        runId: string,
        workflowName: string,
        mode: WorkflowMode,
        startedAt: string,
        metadata: unknown,
        externalKey?: string,
    ): WorkflowRunRecord {
        return {
            id: runId,
            workflow_name: workflowName,
            mode,
            status: 'running',
            started_at: startedAt,
            metadata_json: JSON.stringify(metadata ?? {}),
            completed_at: null,
            external_key: externalKey ?? null,
        };
    }
}
