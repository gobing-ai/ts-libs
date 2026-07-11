import { loadWorkflowDef } from './config';
import { FSMError, WorkflowResumeError } from './errors';
import type { WorkflowEngineHost } from './host';
import { RunLifecycle } from './run-lifecycle';
import { StateMachineDriver } from './state-machine';
import { TransitionFlowDriver } from './transition-flow';
import type {
    StateMachineWorkflowDef,
    TransitionDenied,
    TransitionRequestResult,
    WorkflowDef,
    WorkflowPersistenceAdapter,
    WorkflowRunOptions,
    WorkflowRunRecord,
    WorkflowRunResult,
} from './types';
import { resolveTemplates } from './variables';

/** High-level workflow service for loading, running, and listing persisted workflow runs. */
export class WorkflowService {
    /** Per-run serialization: ensures concurrent requestTransition calls serialize. */
    private readonly runLocks = new Map<string, Promise<void>>();

    constructor(
        private readonly host: WorkflowEngineHost,
        private readonly persistence: WorkflowPersistenceAdapter,
    ) {}

    /** Load a workflow file and validate it. */
    async load(path: string): Promise<WorkflowDef> {
        return await loadWorkflowDef(path);
    }

    /** Run an already-loaded workflow definition. */
    async run(workflow: WorkflowDef, options: WorkflowRunOptions = {}): Promise<WorkflowRunResult> {
        if (workflow.kind === 'transition-flow') {
            return await new TransitionFlowDriver({ host: this.host, persistence: this.persistence }).run(
                workflow,
                options,
            );
        }
        return await new StateMachineDriver({ host: this.host, persistence: this.persistence }).run(workflow, options);
    }

    /** Load and run a workflow file. */
    async runFile(path: string, options: WorkflowRunOptions = {}): Promise<WorkflowRunResult> {
        return await this.run(await this.load(path), options);
    }

    /** List persisted workflow runs. */
    async listRuns() {
        return await this.persistence.listRuns();
    }

    /** Find a run by its external key within a workflow definition. */
    async findRunByKey(workflowName: string, externalKey: string): Promise<WorkflowRunRecord | undefined> {
        return await this.persistence.findRunByKey(workflowName, externalKey);
    }

    /** Create a new run or attach to an existing one identified by external key. */
    async createOrAttachRun(record: WorkflowRunRecord): Promise<WorkflowRunRecord> {
        return await this.persistence.createOrAttachRun(record);
    }

    /** Force-set the current state of a run (consumer-side authority reconciliation). */
    async reseedRun(
        workflow: WorkflowDef,
        runId: string,
        newState: string,
        options?: WorkflowRunOptions,
    ): Promise<void>;
    async reseedRun(runId: string, newState: string, options?: WorkflowRunOptions): Promise<void>;
    async reseedRun(
        workflowOrRunId: WorkflowDef | string,
        runIdOrNewState: string,
        newStateOrOptions?: string | WorkflowRunOptions,
        maybeOptions?: WorkflowRunOptions,
    ): Promise<void> {
        // Normalize the two overloads to a single typed shape exactly once, so the
        // commit path below never re-discriminates or casts.
        const args =
            typeof workflowOrRunId === 'string'
                ? {
                      workflow: undefined,
                      runId: workflowOrRunId,
                      newState: runIdOrNewState,
                      options: newStateOrOptions as WorkflowRunOptions | undefined,
                  }
                : {
                      workflow: workflowOrRunId,
                      runId: runIdOrNewState,
                      newState: newStateOrOptions as string,
                      options: maybeOptions,
                  };

        if (args.workflow !== undefined) {
            this.assertReseedTargetDeclared(args.workflow, args.runId, args.newState);
        }
        await this.commitReseed(args.runId, args.newState, args.options);
    }

    /** Reject a reseed target the workflow definition does not allow (state-machine states only). */
    private assertReseedTargetDeclared(workflow: WorkflowDef, runId: string, newState: string): void {
        if (workflow.kind === 'transition-flow') {
            throw new FSMError('reseedRun only supports state-machine workflows');
        }
        if (!workflow.states.some((state) => state.id === newState)) {
            throw new FSMError(`Cannot reseed run "${runId}" to undeclared state "${newState}"`);
        }
    }

    /** Persist the reseed and emit the corrective event with the run's external key. */
    private async commitReseed(runId: string, newState: string, options?: WorkflowRunOptions): Promise<void> {
        const run = await this.persistence.loadRun(runId);
        const extKey = run?.external_key ?? undefined;
        const result = await this.persistence.reseedRun(runId, newState);
        void options?.events?.emit('workflow.run.reseeded', {
            runId,
            fromState: result.fromState ?? '',
            toState: result.toState,
            externalKey: extKey,
        });
    }

    /** Resume a paused run, continuing execution from where it stopped. */
    async resumeRun(workflow: WorkflowDef, runId: string, options?: WorkflowRunOptions): Promise<WorkflowRunResult> {
        const run = await this.persistence.loadRun(runId);
        if (run === undefined) {
            throw new WorkflowResumeError(`Run "${runId}" not found`);
        }
        if (run.status !== 'paused') {
            throw new WorkflowResumeError(`Run "${runId}" is not paused (status: ${run.status})`);
        }

        const currentState = await this.persistence.loadCurrentState(runId);
        if (currentState === undefined) {
            throw new WorkflowResumeError(`Run "${runId}" has no persisted state to resume from`);
        }

        // Re-open the run as running.
        const extKey = run.external_key ?? undefined;
        await this.persistence.finalizeRun(runId, 'running', '');
        void options?.events?.emit('workflow.run.resumed', { runId, node: currentState, externalKey: extKey });

        // Resume through the appropriate driver, starting from the paused state (skip on-enter).
        if (workflow.kind === 'transition-flow') {
            return await new TransitionFlowDriver({
                host: this.host,
                persistence: this.persistence,
            }).resume(workflow, runId, currentState, extKey, options);
        }
        return await new StateMachineDriver({
            host: this.host,
            persistence: this.persistence,
        }).resume(workflow as StateMachineWorkflowDef, runId, currentState, extKey, options);
    }

    /** List runs currently paused. Optional filters and ordering. */
    async listPausedRuns(options?: { workflowName?: string; limit?: number }): Promise<readonly WorkflowRunRecord[]> {
        return await this.persistence.listPausedRuns(options);
    }

    /**
     * Request an external state transition on a run. Evaluates whether the
     * transition exists and its guard passes; commits or denies atomically.
     * Concurrent requests on the same run serialize — the loser re-evaluates
     * against the new state.
     */
    async requestTransition(
        workflow: StateMachineWorkflowDef,
        runId: string,
        toState: string,
        options?: WorkflowRunOptions,
    ): Promise<TransitionRequestResult> {
        // Serialize per-run: chain onto the existing lock, then clean up.
        let release!: () => void;
        const previous = this.runLocks.get(runId) ?? Promise.resolve();
        const next = previous.then(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        this.runLocks.set(runId, next);
        await previous;
        try {
            return await this.evaluateAndCommit(workflow, runId, toState, options);
        } finally {
            release();
            if (this.runLocks.get(runId) === next) {
                this.runLocks.delete(runId);
            }
        }
    }

    private async evaluateAndCommit(
        workflow: StateMachineWorkflowDef,
        runId: string,
        toState: string,
        options?: WorkflowRunOptions,
    ): Promise<TransitionRequestResult> {
        const currentState = await this.persistence.loadCurrentState(runId);
        const run = await this.persistence.loadRun(runId);
        const extKey = run?.external_key ?? undefined;
        if (currentState === undefined) {
            // No state recorded yet: nothing to transition from, and no `from` to
            // address a denial event at — return the denial without emitting.
            return {
                allowed: false,
                reason: 'no-such-transition',
                detail: `No state recorded for run "${runId}"`,
            };
        }

        // An external transition is a single guarded hop on an existing run, not a
        // run itself — borrow a span-free lifecycle so the transition persist+emit
        // mechanics reuse the same seam the drivers use (no new workflow.run span).
        const lifecycle = RunLifecycle.forExternalTransition(
            workflow.name,
            runId,
            { persistence: this.persistence, events: options?.events },
            extKey,
        );

        // Find the matching transition from current state to requested state.
        const transition = workflow.transitions.find((t) => t.from === currentState && t.to === toState);
        if (transition === undefined) {
            return this.denyTransition(options, runId, currentState, toState, extKey, {
                reason: 'no-such-transition',
                detail: `No transition from "${currentState}" to "${toState}"`,
            });
        }

        // Evaluate guard if present.
        if (transition.guard !== undefined) {
            // Resolve ${vars.*} templates in guard options against the workflow's vars —
            // external transitions (requestTransition) must interpolate the same way the
            // driver's firstPassingTransition does (e.g. `spur task check ${vars.wbs}`).
            const resolvedGuardOptions = resolveTemplates(transition.guard.options ?? {}, {
                vars: workflow.vars ?? {},
                env: {},
            });
            const guardResult = await this.host.evaluateGuardResult(transition.guard.kind, resolvedGuardOptions, {
                runId,
                current: currentState,
                vars: workflow.vars ?? {},
                workdir: options?.workdir,
            });
            lifecycle.guardEvaluated(currentState, toState, transition.guard.kind, guardResult.passed);
            if (!guardResult.passed) {
                return this.denyTransition(options, runId, currentState, toState, extKey, {
                    reason: 'guard-failed',
                    detail: `Guard "${transition.guard.kind}" denied transition from "${currentState}" to "${toState}"`,
                    guardKind: transition.guard.kind,
                    ...(guardResult.report === undefined ? {} : { guardReport: guardResult.report }),
                });
            }
        }

        // Commit: atomically persist the transition + state snapshot in a single
        // batch (ADR-020), then emit the external-only requested event. No phase
        // record — external transitions don't drive phase tracking.
        const trigger = transition.trigger ?? null;
        await lifecycle.commitHop(currentState, toState, trigger, 0);
        void options?.events?.emit('workflow.transition.requested', {
            runId,
            from: currentState,
            to: toState,
            trigger,
            externalKey: extKey,
        });
        return { allowed: true, fromState: currentState, toState };
    }

    /**
     * Build a `TransitionDenied` result and emit its `workflow.transition.denied`
     * event in one place — the single denial seam for the external-transition path,
     * so the event payload and the returned reason can never drift apart.
     */
    private denyTransition(
        options: WorkflowRunOptions | undefined,
        runId: string,
        from: string,
        to: string,
        externalKey: string | undefined,
        denial: Omit<TransitionDenied, 'allowed'>,
    ): TransitionDenied {
        void options?.events?.emit('workflow.transition.denied', {
            runId,
            from,
            to,
            reason: denial.reason,
            externalKey,
        });
        return { allowed: false, ...denial };
    }
}
