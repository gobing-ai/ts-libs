import { type BusLifecycleEvents, EventBus } from '@gobing-ai/ts-infra';
import { loadWorkflowDef } from './config';
import { FSMError, WorkflowResumeError } from './errors';
import type { WorkflowEngineEvents } from './events';
import type { WorkflowEngineHost } from './host';
import { RunLifecycle, snapshotActionResult, snapshotTransitions } from './run-lifecycle';
import { StateMachineDriver } from './state-machine';
import { TransitionFlowDriver } from './transition-flow';
import type {
    ResumeOwnership,
    StateMachineWorkflowDef,
    TransitionDenied,
    TransitionRequestResult,
    Vars,
    WorkflowDef,
    WorkflowPersistenceAdapter,
    WorkflowResumeMode,
    WorkflowRunOptions,
    WorkflowRunRecord,
    WorkflowRunResult,
} from './types';
import { mergeVars, resolveTemplates } from './variables';

/** High-level workflow service for loading, running, and listing persisted workflow runs. */
export class WorkflowService {
    /** Per-run serialization: ensures concurrent requestTransition calls serialize. */
    private readonly runLocks = new Map<string, Promise<void>>();
    private readonly lifecycleBus: EventBus<BusLifecycleEvents> | undefined;

    constructor(
        private readonly host: WorkflowEngineHost,
        private readonly persistence: WorkflowPersistenceAdapter,
        /**
         * Optional lifecycle bus to bridge `workflow.*` events into the
         * application System Events stream (R3). When a run's `events` is
         * omitted the service constructs an internal
         * `EventBus<WorkflowEngineEvents>` parented to this bus so workflow
         * events appear in the JSONL log.
         */
        lifecycleBus?: EventBus<BusLifecycleEvents>,
    ) {
        this.lifecycleBus = lifecycleBus ?? host.lifecycleBus;
    }

    /** Resolve a run's event bus: caller-supplied wins; otherwise parent to the service lifecycle bus. */
    private resolveEvents(
        events: EventBus<WorkflowEngineEvents> | undefined,
    ): EventBus<WorkflowEngineEvents> | undefined {
        return (
            events ??
            (this.lifecycleBus ? new EventBus<WorkflowEngineEvents>({ lifecycleBus: this.lifecycleBus }) : undefined)
        );
    }

    /** Load a workflow file and validate it. */
    async load(path: string): Promise<WorkflowDef> {
        return await loadWorkflowDef(path);
    }

    /** Run an already-loaded workflow definition. */
    async run(workflow: WorkflowDef, options: WorkflowRunOptions = {}): Promise<WorkflowRunResult> {
        const events = this.resolveEvents(options.events);
        if (workflow.kind === 'transition-flow') {
            return await new TransitionFlowDriver({ host: this.host, persistence: this.persistence }).run(workflow, {
                ...options,
                events,
            });
        }
        return await new StateMachineDriver({ host: this.host, persistence: this.persistence }).run(workflow, {
            ...options,
            events,
        });
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
        void this.resolveEvents(options?.events)?.emit('workflow.run.reseeded', {
            runId,
            fromState: result.fromState ?? '',
            toState: result.toState,
            externalKey: extKey,
            severity: 'warning',
        });
    }

    /** Resume a paused run, continuing execution from where it stopped. */
    async resumeRun(workflow: WorkflowDef, runId: string, options?: WorkflowRunOptions): Promise<WorkflowRunResult> {
        const run = await this.persistence.loadRun(runId);
        if (run === undefined) {
            throw new WorkflowResumeError(`Run "${runId}" not found`);
        }
        if (run.status !== 'paused' && run.status !== 'interrupted') {
            throw new WorkflowResumeError(`Run "${runId}" is not resumable (status: ${run.status})`);
        }
        const currentState = await this.persistence.loadCurrentState(runId);
        if (currentState === undefined) {
            throw new WorkflowResumeError(`Run "${runId}" has no persisted state to resume from`);
        }

        // Resolve recovery semantics (task 0902): interrupted runs default to re-running
        // the current state's actions (they may have half-completed at the interruption);
        // paused runs default to skipping them (pause is declared after actions complete).
        // An explicit `resumeMode` option overrides either default.
        const resumeMode: WorkflowResumeMode =
            options?.resumeMode ?? (run.status === 'interrupted' ? 'rerun-enter' : 'skip-enter');
        this.assertResumeRerunAllowed(workflow, currentState, resumeMode);

        // Restore effectiveVars persisted in the last state snapshot so resume
        // continues with the same runtime variables (e.g. `__hitlAnswer`). Caller
        // overrides in `options.vars` win over the persisted snapshot (R3 of 0366).
        const snapshot = await this.persistence.loadLatestStateSnapshot(runId);
        const persistedVars = extractEffectiveVars(snapshot?.data);
        const restoredVars = mergeVars(persistedVars, options?.vars);
        const owner: ResumeOwnership = options?.resumeOwner ?? { attemptId: crypto.randomUUID() };
        const mergedOptions: WorkflowRunOptions = { ...options, vars: restoredVars, resumeMode };

        // Atomically claim ownership (task 0902 R3): the status flip and owner recording
        // happen in one CAS update, so exactly one concurrent resume wins; losers and
        // stale owners get a typed error instead of double-driving the run.
        const claimed = await this.persistence.claimRunOwnership(runId, owner, ['paused', 'interrupted']);
        if (claimed === undefined) {
            const current = await this.persistence.loadRun(runId);
            throw new WorkflowResumeError(
                `Run "${runId}" could not be claimed for resume ` +
                    `(status: ${current?.status ?? 'unknown'}, owner: ${current?.owner_attempt ?? 'none'})`,
            );
        }

        const extKey = claimed.external_key ?? undefined;
        const events = this.resolveEvents(mergedOptions.events);
        void events?.emit('workflow.run.resumed', {
            runId,
            node: currentState,
            resumeMode,
            ownerAttemptId: owner.attemptId,
            externalKey: extKey,
            severity: 'info',
        });

        // Resume through the appropriate driver, starting from the persisted state.
        if (workflow.kind === 'transition-flow') {
            return await new TransitionFlowDriver({
                host: this.host,
                persistence: this.persistence,
            }).resume(workflow, runId, currentState, extKey, mergedOptions);
        }
        return await new StateMachineDriver({
            host: this.host,
            persistence: this.persistence,
        }).resume(workflow as StateMachineWorkflowDef, runId, currentState, extKey, mergedOptions);
    }

    /**
     * Mark a running run as interrupted (task 0902 R2) — crash/lost-owner
     * reconciliation so an abandoned run can later be rerun-resumed instead of
     * wedging in 'running' forever. CAS: returns undefined when the run is
     * missing or not running (already terminal/paused/claimed).
     */
    async interruptRun(runId: string, reason: string): Promise<WorkflowRunRecord | undefined> {
        const interrupted = await this.persistence.interruptRun(runId, reason);
        if (interrupted !== undefined) {
            const events = this.resolveEvents(undefined);
            void events?.emit('workflow.run.interrupted', {
                runId,
                reason,
                externalKey: interrupted.external_key ?? undefined,
                severity: 'warning',
            });
        }
        return interrupted;
    }

    /** Refuse rerun-resume into states the author has not declared safe to re-run (task 0902 R1/R2). */
    private assertResumeRerunAllowed(
        workflow: WorkflowDef,
        currentState: string,
        resumeMode: WorkflowResumeMode,
    ): void {
        if (resumeMode !== 'rerun-enter') return;
        const node =
            workflow.kind === 'transition-flow'
                ? workflow.nodes.find((candidate) => candidate.id === currentState)
                : (workflow as StateMachineWorkflowDef).states.find((candidate) => candidate.id === currentState);
        if (node !== undefined && node.resumeRerun !== true) {
            throw new FSMError(
                `Cannot rerun-resume into "${currentState}": not marked resumeRerun: true ` +
                    '(mark its actions as safe to re-run — idempotent or deduped by runId+state — or resume with resumeMode: "skip-enter")',
            );
        }
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
        const events = this.resolveEvents(options?.events);

        // An external transition is a single guarded hop on an existing run, not a
        // run itself — borrow a span-free lifecycle so the transition persist+emit
        // mechanics reuse the same seam the drivers use (no new workflow.run span).
        const lifecycle = RunLifecycle.forExternalTransition(
            workflow.name,
            runId,
            { persistence: this.persistence, events },
            extKey,
        );

        // Find the matching transition from current state to requested state.
        const transition = workflow.transitions.find((t) => t.from === currentState && t.to === toState);
        if (transition === undefined) {
            return this.denyTransition(events, runId, currentState, toState, extKey, {
                reason: 'no-such-transition',
                detail: `No transition from "${currentState}" to "${toState}"`,
            });
        }

        const snapshot = await this.persistence.loadLatestStateSnapshot(runId);
        const vars = mergeVars(mergeVars(workflow.vars, extractEffectiveVars(snapshot?.data)), options?.vars);

        // Evaluate guard if present.
        if (transition.guard !== undefined) {
            // Resolve ${vars.*} templates against the restored and overridden runtime vars —
            // external transitions (requestTransition) must interpolate the same way the
            // driver's firstPassingTransition does (e.g. `spur task check ${vars.wbs}`).
            const resolvedGuardOptions = resolveTemplates(transition.guard.options ?? {}, {
                vars,
                env: {},
            });
            const guardResult = await this.host.evaluateGuardResult(transition.guard.kind, resolvedGuardOptions, {
                runId,
                current: currentState,
                lastActionResult: snapshotActionResult(snapshot?.data),
                vars,
                workdir: options?.workdir,
            });
            lifecycle.guardEvaluated(currentState, toState, transition.guard.kind, guardResult.passed);
            if (!guardResult.passed) {
                return this.denyTransition(events, runId, currentState, toState, extKey, {
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
        await lifecycle.commitHop(
            currentState,
            toState,
            trigger,
            snapshotTransitions(snapshot?.data) + 1,
            undefined,
            vars,
        );
        void events?.emit('workflow.transition.requested', {
            runId,
            from: currentState,
            to: toState,
            trigger,
            externalKey: extKey,
            severity: 'info',
        });
        return { allowed: true, fromState: currentState, toState };
    }

    /**
     * Build a `TransitionDenied` result and emit its `workflow.transition.denied`
     * event in one place — the single denial seam for the external-transition path,
     * so the event payload and the returned reason can never drift apart.
     */
    private denyTransition(
        events: EventBus<WorkflowEngineEvents> | undefined,
        runId: string,
        from: string,
        to: string,
        externalKey: string | undefined,
        denial: Omit<TransitionDenied, 'allowed'>,
    ): TransitionDenied {
        void events?.emit('workflow.transition.denied', {
            runId,
            from,
            to,
            reason: denial.reason,
            externalKey,
            severity: 'error',
        });
        return { allowed: false, ...denial };
    }
}

/**
 * Read `effectiveVars` from a state snapshot's data payload. Tolerates older
 * snapshots that lack the field (returns `{}`) and silently drops non-string
 * values, matching `mergeSetVars`'s defensive contract.
 */
function extractEffectiveVars(data: Record<string, unknown> | undefined): Vars {
    if (data === undefined) return {};
    const raw = data.effectiveVars;
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object') return {};
    const filtered: Vars = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'string') filtered[key] = value;
    }
    return filtered;
}
