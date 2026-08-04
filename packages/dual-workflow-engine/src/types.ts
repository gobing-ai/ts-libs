/** Action error handling policy: fail-fast or log-and-continue. */
export type OnErrorPolicy = 'fail' | 'continue';

import type { EventBus } from '@gobing-ai/ts-infra';
import type { WorkflowEngineEvents } from './events';

/** Workflow execution status persisted for runs and phases. */
export type WorkflowStatus = 'running' | 'done' | 'failed' | 'paused';

/** Runtime variables and user variables available to workflow definitions. */
export type Vars = Record<string, string>;

/** Environment allowlist carried by a workflow definition. */
export interface Env {
    readonly allow?: readonly string[];
}

/** Workflow action definition executed by a host action runner. */
export interface ActionDef {
    readonly kind: string;
    readonly options?: Record<string, unknown>;
    /** Per-action error policy override. Falls back to workflow default then run-option then 'fail'. */
    readonly onError?: OnErrorPolicy;
}

/** Guard predicate definition used by state-machine transitions and transition-flow edges. */
export interface GuardDef {
    readonly kind: string;
    readonly options?: Record<string, unknown>;
}

/** One state in a state-machine workflow. */
export interface StateDef {
    readonly id: string;
    /** Optional human description of what this state does. */
    readonly description?: string;
    readonly onEnter?: readonly ActionDef[];
    readonly onExit?: readonly ActionDef[];
    /** When true, the engine pauses the run at this state instead of auto-advancing. */
    readonly pause?: boolean;
}

/** One transition in a state-machine workflow. */
export interface TransitionDef {
    readonly from: string;
    readonly to: string;
    /** Optional human description of when/why this transition is taken. */
    readonly description?: string;
    readonly trigger?: string;
    readonly guard?: GuardDef;
}

/** State-machine workflow definition. */
export interface StateMachineWorkflowDef {
    readonly kind?: 'state-machine';
    readonly name: string;
    /** Optional behavior-free document version tag. */
    readonly version?: string;
    /** Optional human description of the workflow's purpose. */
    readonly description?: string;
    readonly initialState: string;
    readonly terminalStates?: readonly string[];
    /**
     * Subset of `terminalStates` whose reach marks the run as failed rather
     * than done. Absent ⇒ every terminal state is a success (today's behavior).
     */
    readonly failureStates?: readonly string[];
    readonly iterationBound?: number;
    /** Default error policy applied to actions that don't specify their own. Defaults to 'fail'. */
    readonly defaultOnError?: OnErrorPolicy;
    readonly vars?: Vars;
    readonly env?: Env;
    readonly states: readonly StateDef[];
    readonly transitions: readonly TransitionDef[];
}

/** Transition-flow node definition. */
export interface FlowNodeDef {
    readonly id: string;
    /** Optional human description of what this node does. */
    readonly description?: string;
    readonly type?: 'action' | 'gate' | 'parallel' | 'decision';
    readonly action?: ActionDef;
    /** When true, the engine pauses the run at this node instead of auto-advancing. */
    readonly pause?: boolean;
}

/** Transition-flow edge definition. */
export interface FlowEdgeDef {
    readonly from: string;
    readonly to: string;
    /** Optional human description of when/why this edge is taken. */
    readonly description?: string;
    readonly condition?: GuardDef;
}

/** Transition-flow workflow definition. */
export interface TransitionFlowWorkflowDef {
    readonly kind: 'transition-flow';
    readonly name: string;
    /** Optional behavior-free document version tag. */
    readonly version?: string;
    /** Optional human description of the workflow's purpose. */
    readonly description?: string;
    readonly initialNode: string;
    readonly terminalNodes?: readonly string[];
    readonly iterationBound?: number;
    /** Default error policy applied to actions that don't specify their own. Defaults to 'fail'. */
    readonly defaultOnError?: OnErrorPolicy;
    readonly vars?: Vars;
    readonly env?: Env;
    readonly nodes: readonly FlowNodeDef[];
    readonly edges: readonly FlowEdgeDef[];
}

/** Discriminated workflow definition union. */
export type WorkflowDef = StateMachineWorkflowDef | TransitionFlowWorkflowDef;

/** Action execution context passed to action runners. */
export interface ActionRunContext {
    readonly runId: string;
    /** Engine-owned persisted action identity for correlation and safe control targeting. */
    readonly actionId?: string;
    readonly workdir?: string;
    readonly stateOrNodeId: string;
    readonly vars: Vars;
    readonly env: Record<string, string>;
    readonly metadata?: Record<string, unknown>;
    /** Optional event bus for in-process run observability. Action runners can emit workflow events through this. */
    readonly events?: EventBus<WorkflowEngineEvents>;
}

/** Result of a single action execution. */
export interface ActionResult {
    readonly ok: boolean;
    readonly data?: Record<string, unknown>;
    readonly error?: string;
    readonly terminal?: boolean;
    /** Variables to merge into the run's vars for subsequent steps. Shallow string→string override. */
    readonly setVars?: Vars;
}

/** Action runner implementation registered in the workflow host. */
export interface ActionRunner {
    readonly kind: string;
    execute(options: Record<string, unknown>, context: ActionRunContext): Promise<ActionResult>;
}

/** Guard evaluation context. */
export interface GuardContext {
    readonly runId: string;
    readonly current: string;
    readonly vars: Vars;
    readonly workdir?: string;
    readonly lastActionResult?: ActionResult;
}

/** Rich guard evaluation result. Boolean guard runners remain supported for compatibility. */
export interface GuardEvaluationResult {
    readonly passed: boolean;
    readonly report?: unknown;
}

/** Guard runner implementation registered in the workflow host. */
export interface GuardRunner {
    readonly kind: string;
    evaluate(options: Record<string, unknown>, context: GuardContext): Promise<boolean | GuardEvaluationResult>;
}

/** Input for running a workflow. */
export interface WorkflowRunOptions {
    readonly runId?: string;
    readonly workdir?: string;
    readonly vars?: Vars;
    readonly env?: Record<string, string | undefined>;
    readonly metadata?: Record<string, unknown>;
    /** Optional event bus for structured run observability. */
    readonly events?: EventBus<WorkflowEngineEvents>;
    /** Run-level error policy override. Lowest precedence; action-level wins. */
    readonly onError?: OnErrorPolicy;
    /** Validate the definition and walk the transition graph without executing actions. */
    readonly dryRun?: boolean;
    /** Optional caller-supplied external key, unique per workflow definition. */
    readonly externalKey?: string;
}

/** Result returned by both driver loops. */
export interface WorkflowRunResult {
    readonly runId: string;
    readonly workflowName: string;
    readonly mode: 'state-machine' | 'transition-flow';
    readonly status: WorkflowStatus;
    readonly finalState: string;
    readonly transitionsTaken: number;
    readonly reason?: string;
}

/** Persisted workflow run record. */
export interface WorkflowRunRecord {
    readonly id: string;
    readonly workflow_name: string;
    readonly mode: string;
    readonly status: WorkflowStatus;
    readonly started_at: string;
    readonly completed_at: string | null;
    readonly metadata_json: string;
    /** Optional caller-supplied external key, unique per workflow definition. */
    readonly external_key?: string | null;
}

/** Result of force-setting the current state of a run. */
export interface WorkflowReseedResult {
    readonly fromState: string | null;
    readonly toState: string;
}

/** Reason categories when an external transition request is denied. */
export type TransitionDeniedReason = 'no-such-transition' | 'guard-failed';

/** Result when an external transition request is allowed. */
export interface TransitionAllowed {
    readonly allowed: true;
    /** The state the run has moved to. */
    readonly toState: string;
    /** The state the run moved from. */
    readonly fromState: string;
}

/** Result when an external transition request is denied. */
export interface TransitionDenied {
    readonly allowed: false;
    /** Machine-readable reason category. */
    readonly reason: TransitionDeniedReason;
    /** Human-readable detail from the guard (when guard-failed) or transition lookup. */
    readonly detail: string;
    /** The guard kind that was evaluated (when guard-failed). */
    readonly guardKind?: string;
    /** Machine-readable guard report/output when a guard was evaluated. */
    readonly guardReport?: unknown;
}

/** Discriminated union result for external transition requests. */
export type TransitionRequestResult = TransitionAllowed | TransitionDenied;

/** Persisted action run record — one row per action executed in a workflow run. */
export interface ActionRunRecord {
    readonly id: string;
    readonly run_id: string;
    readonly node: string;
    readonly kind: string;
    readonly status: WorkflowStatus;
    readonly duration_ms: number | null;
    readonly ok: number | null;
    readonly result_json: string | null;
    readonly started_at: string | null;
    readonly completed_at: string | null;
}

/** Optional redaction hook: given action options, return sanitized options for persistence. */
export type ActionRedactor = (kind: string, options: Record<string, unknown>) => Record<string, unknown>;

/** Persistence adapter implemented by DB-backed and test stores. */
export interface WorkflowPersistenceAdapter {
    createRun(record: WorkflowRunRecord): Promise<void>;
    finalizeRun(runId: string, status: WorkflowStatus, completedAt: string): Promise<void>;
    savePhase(runId: string, phase: string, status: WorkflowStatus): Promise<void>;
    saveTransition(runId: string, from: string, to: string, trigger: string | null): Promise<void>;
    saveWorkflowState(runId: string, state: string, data: Record<string, unknown>): Promise<void>;
    /**
     * Atomically persist a transition together with its resulting state snapshot
     * and optional phase record in a single DB batch — either all commit or none.
     * Prevents partial-state windows when the process fails between saveTransition()
     * and saveWorkflowState().
     */
    commitTransition(
        runId: string,
        from: string,
        to: string,
        trigger: string | null,
        state: string,
        data: Record<string, unknown>,
        phase?: { phase: string; status: WorkflowStatus },
    ): Promise<void>;
    /**
     * Two-phase action persistence: insert a running row at action start. Returns the action row id.
     * The `options` param forwards the resolved step options to an observability/mirroring wrapper;
     * persistence implementations ignore it (mirror-only — no new column, no alter, no redaction).
     */
    saveActionStart(runId: string, node: string, kind: string, options?: Record<string, unknown>): Promise<string>;
    /** Finalize an action row with duration, ok, result. */
    saveActionFinalize(
        actionId: string,
        status: WorkflowStatus,
        durationMs: number,
        ok: boolean,
        result?: unknown,
        redactor?: ActionRedactor,
    ): Promise<void>;
    loadRun(runId: string): Promise<WorkflowRunRecord | undefined>;
    listRuns(): Promise<readonly WorkflowRunRecord[]>;
    /** Look up a run by its external key within a workflow definition. Returns undefined if not found. */
    findRunByKey(workflowName: string, externalKey: string): Promise<WorkflowRunRecord | undefined>;
    /** Create a run or attach to an existing one by external key. Atomic create-or-attach semantics. */
    createOrAttachRun(record: WorkflowRunRecord): Promise<WorkflowRunRecord>;
    /** Force-set the current state of a run (consumer-side authority reconciliation). */
    reseedRun(runId: string, newState: string): Promise<WorkflowReseedResult>;
    /** Load the current state name for a run (latest state snapshot). Returns undefined if no state recorded. */
    loadCurrentState(runId: string): Promise<string | undefined>;
    /**
     * Load the latest state snapshot for a run — the full data payload (including
     * `effectiveVars` when present), not just the state name. Used by resume to
     * restore the post-action variable state that was active when the run paused.
     * Old snapshots written before R1 of 0366 have no `effectiveVars` field;
     * callers must tolerate `data.effectiveVars === undefined` and fall back to {}.
     * Returns undefined if no state recorded.
     */
    loadLatestStateSnapshot(runId: string): Promise<{ state: string; data: Record<string, unknown> } | undefined>;
    /** List runs with status 'paused'. Optional filters: workflow name, limit. Ordered most-recent-first. */
    listPausedRuns(options?: { workflowName?: string; limit?: number }): Promise<readonly WorkflowRunRecord[]>;
}
