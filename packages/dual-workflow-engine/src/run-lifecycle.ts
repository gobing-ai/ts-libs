import {
    addSpanEvent,
    type BusLifecycleEvents,
    EventBus,
    getLogger,
    type Logger,
    traceAsync,
} from '@gobing-ai/ts-infra';
import { getProcessEnv } from '@gobing-ai/ts-runtime';
import type { WorkflowEngineEvents } from './events';
import type {
    Vars,
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
    /** Parent bus used when RunLifecycle must construct its own workflow event bus. */
    readonly lifecycleBus?: EventBus<BusLifecycleEvents>;
}

/**
 * Owns the run-level bookkeeping shared by both drivers: run identity, the
 * create→phase→finalize persistence sequence, and observability (one OTel span
 * per run plus structured log lines). The two driver control loops stay
 * dialect-specific (ADR-006 §7) and call into this for every persistence touch.
 */
export class RunLifecycle {
    readonly runId: string;
    readonly externalKey?: string;
    private readonly persistence: WorkflowPersistenceAdapter;
    private readonly events: EventBus<WorkflowEngineEvents> | undefined;
    private readonly logger: Logger;

    private constructor(
        runId: string,
        private readonly workflowName: string,
        private readonly mode: WorkflowMode,
        deps: RunLifecycleDeps,
        externalKey?: string,
    ) {
        this.runId = runId;
        this.externalKey = externalKey;
        this.persistence = deps.persistence;
        this.events =
            deps.events ??
            (deps.lifecycleBus ? new EventBus<WorkflowEngineEvents>({ lifecycleBus: deps.lifecycleBus }) : undefined);
        this.logger = (deps.logger ?? getLogger('workflow')).child({ runId, workflow: workflowName, mode });
    }

    /**
     * Build a lifecycle for an external, single-hop transition request — NOT a run.
     * Unlike {@link run} / {@link resume} this opens no `workflow.run` span and
     * creates no run record: an external transition is one guarded hop on an
     * already-existing run, so it must not masquerade as a run in traces. It exists
     * only to let {@link WorkflowService.requestTransition} reuse {@link recordTransition}
     * and {@link guardEvaluated} so the transition persist+emit mechanics live in one
     * place instead of being hand-rolled at the service layer.
     */
    static forExternalTransition(
        workflowName: string,
        runId: string,
        deps: RunLifecycleDeps,
        externalKey: string | undefined,
    ): RunLifecycle {
        return new RunLifecycle(runId, workflowName, 'state-machine', deps, externalKey);
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
                const extKey = record.external_key ?? undefined;
                const lifecycle = new RunLifecycle(record.id, workflowName, mode, deps, extKey);
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
                    externalKey: extKey,
                });
                return await loop(lifecycle);
            },
            { attributes: { 'workflow.name': workflowName, 'workflow.mode': mode } },
        );
    }

    /**
     * Resume an existing run without creating a new record. Used by driver resume paths.
     * The caller is responsible for ensuring the run exists and emitting the resumed event.
     */
    static async resume(
        workflowName: string,
        mode: WorkflowMode,
        deps: RunLifecycleDeps,
        runId: string,
        externalKey: string | undefined,
        loop: (lifecycle: RunLifecycle) => Promise<WorkflowRunResult>,
    ): Promise<WorkflowRunResult> {
        return await traceAsync(
            'workflow.run',
            async () => {
                const lifecycle = new RunLifecycle(runId, workflowName, mode, deps, externalKey);
                lifecycle.logger.info('workflow run resumed');
                return await loop(lifecycle);
            },
            { attributes: { 'workflow.name': workflowName, 'workflow.mode': mode } },
        );
    }

    /**
     * Persist the current state/node snapshot and mark its phase running.
     * When `persist` is false (set by driver loops after `commitHop` already
     * persisted the state atomically), only emit the enter observability —
     * skip `saveWorkflowState` + `savePhase` to avoid duplicate INSERT rows.
     */
    async enter(stateOrNodeId: string, transitionsTaken: number, persist = true, vars?: Vars): Promise<void> {
        if (persist) {
            const data: Record<string, unknown> = { transitionsTaken };
            if (vars !== undefined) data.effectiveVars = vars;
            await this.persistence.saveWorkflowState(this.runId, stateOrNodeId, data);
            await this.persistence.savePhase(this.runId, stateOrNodeId, 'running');
        }
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

    /**
     * Atomically commit a transition together with the resulting state snapshot
     * and optional phase record, then emit the transition observability event.
     * Replaces the old `recordTransition` + `enter` pair at every driver hop
     * site so a crash between writes is impossible (ADR-020). Emits
     * `workflow.node.transition` only after the batch commits — a rolled-back
     * batch emits nothing (R1.6).
     */
    async commitHop(
        from: string,
        to: string,
        trigger: string | null,
        transitionsTaken: number,
        phase?: { phase: string; status: WorkflowStatus },
        vars?: Vars,
    ): Promise<void> {
        const data: Record<string, unknown> = { transitionsTaken };
        if (vars !== undefined) data.effectiveVars = vars;
        await this.persistence.commitTransition(this.runId, from, to, trigger, to, data, phase);
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
            externalKey: this.externalKey,
        });
    }
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
            externalKey: this.externalKey,
        });
    }

    /** Finalize the run as succeeded and return its result. */
    async done(finalState: string, transitionsTaken: number): Promise<WorkflowRunResult> {
        await this.persistence.savePhase(this.runId, finalState, 'done');
        await this.persistence.finalizeRun(this.runId, 'done', new Date().toISOString());
        this.logger.info('workflow run done', { finalState, transitionsTaken });
        addSpanEvent('workflow.run.done', { runId: this.runId, finalState, transitionsTaken });
        void this.events?.emit('workflow.run.done', {
            runId: this.runId,
            finalState,
            transitionsTaken,
            externalKey: this.externalKey,
        });
        return this.result('done', finalState, transitionsTaken);
    }

    /** Finalize the run as failed and return its result. */
    async fail(finalState: string, transitionsTaken: number, reason = 'failed'): Promise<WorkflowRunResult> {
        await this.persistence.savePhase(this.runId, finalState, 'failed');
        await this.persistence.finalizeRun(this.runId, 'failed', new Date().toISOString());
        addSpanEvent('workflow.run.failed', { runId: this.runId, finalState, reason });
        void this.events?.emit('workflow.run.failed', {
            runId: this.runId,
            finalState,
            reason,
            externalKey: this.externalKey,
        });
        this.logger.warn('workflow run failed', { finalState, transitionsTaken, reason });
        return this.result('failed', finalState, transitionsTaken, reason);
    }

    /**
     * Finalize the run as paused and return its result. Writes a fresh state
     * snapshot carrying the post-action `effectiveVars` BEFORE the phase/finalize
     * writes so resume can restore them — onEnter setVars (e.g. `__hitlAnswer`)
     * would otherwise be lost because the prior snapshot predates this state's
     * action execution (R3 of 0366).
     */
    async pause(stateOrNodeId: string, transitionsTaken: number, vars?: Vars): Promise<WorkflowRunResult> {
        const data: Record<string, unknown> = { transitionsTaken };
        if (vars !== undefined) data.effectiveVars = vars;
        await this.persistence.saveWorkflowState(this.runId, stateOrNodeId, data);
        await this.persistence.savePhase(this.runId, stateOrNodeId, 'paused');
        await this.persistence.finalizeRun(this.runId, 'paused', new Date().toISOString());
        this.logger.info('workflow run paused', { stateOrNodeId, transitionsTaken });
        addSpanEvent('workflow.run.paused', { runId: this.runId, node: stateOrNodeId, transitionsTaken });
        void this.events?.emit('workflow.run.paused', {
            runId: this.runId,
            node: stateOrNodeId,
            transitionsTaken,
            externalKey: this.externalKey,
        });
        return this.result('paused', stateOrNodeId, transitionsTaken);
    }

    /** Emit the resumed event (called by WorkflowService after re-creating a lifecycle for resume). */
    emitResumed(node: string): void {
        addSpanEvent('workflow.run.resumed', { runId: this.runId, node });
        void this.events?.emit('workflow.run.resumed', { runId: this.runId, node, externalKey: this.externalKey });
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
            externalKey: this.externalKey,
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
