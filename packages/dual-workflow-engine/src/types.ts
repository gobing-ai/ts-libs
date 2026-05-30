/** Workflow execution status persisted for runs and phases. */
export type WorkflowStatus = 'running' | 'done' | 'failed';

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
}

/** Guard predicate definition used by state-machine transitions and transition-flow edges. */
export interface GuardDef {
    readonly kind: string;
    readonly options?: Record<string, unknown>;
}

/** One state in a state-machine workflow. */
export interface StateDef {
    readonly id: string;
    readonly onEnter?: readonly ActionDef[];
    readonly onExit?: readonly ActionDef[];
}

/** One transition in a state-machine workflow. */
export interface TransitionDef {
    readonly from: string;
    readonly to: string;
    readonly trigger?: string;
    readonly guard?: GuardDef;
}

/** State-machine workflow definition. */
export interface StateMachineWorkflowDef {
    readonly kind?: 'state-machine';
    readonly name: string;
    readonly initialState: string;
    readonly terminalStates?: readonly string[];
    readonly iterationBound?: number;
    readonly vars?: Vars;
    readonly env?: Env;
    readonly states: readonly StateDef[];
    readonly transitions: readonly TransitionDef[];
}

/** Transition-flow node definition. */
export interface FlowNodeDef {
    readonly id: string;
    readonly type?: 'action' | 'gate' | 'parallel' | 'decision';
    readonly action?: ActionDef;
}

/** Transition-flow edge definition. */
export interface FlowEdgeDef {
    readonly from: string;
    readonly to: string;
    readonly condition?: GuardDef;
}

/** Transition-flow workflow definition. */
export interface TransitionFlowWorkflowDef {
    readonly kind: 'transition-flow';
    readonly name: string;
    readonly initialNode: string;
    readonly terminalNodes?: readonly string[];
    readonly iterationBound?: number;
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
    readonly workdir?: string;
    readonly stateOrNodeId: string;
    readonly vars: Vars;
    readonly env: Record<string, string>;
    readonly metadata?: Record<string, unknown>;
}

/** Result of a single action execution. */
export interface ActionResult {
    readonly ok: boolean;
    readonly data?: Record<string, unknown>;
    readonly error?: string;
    readonly terminal?: boolean;
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
    readonly lastActionResult?: ActionResult;
}

/** Guard runner implementation registered in the workflow host. */
export interface GuardRunner {
    readonly kind: string;
    evaluate(options: Record<string, unknown>, context: GuardContext): Promise<boolean>;
}

/** Input for running a workflow. */
export interface WorkflowRunOptions {
    readonly runId?: string;
    readonly workdir?: string;
    readonly vars?: Vars;
    readonly env?: Record<string, string | undefined>;
    readonly metadata?: Record<string, unknown>;
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
}

/** Persistence adapter implemented by DB-backed and test stores. */
export interface WorkflowPersistenceAdapter {
    createRun(record: WorkflowRunRecord): Promise<void>;
    finalizeRun(runId: string, status: WorkflowStatus, completedAt: string): Promise<void>;
    savePhase(runId: string, phase: string, status: WorkflowStatus): Promise<void>;
    saveTransition(runId: string, from: string, to: string, trigger: string | null): Promise<void>;
    saveWorkflowState(runId: string, state: string, data: Record<string, unknown>): Promise<void>;
    loadRun(runId: string): Promise<WorkflowRunRecord | undefined>;
    listRuns(): Promise<readonly WorkflowRunRecord[]>;
}
