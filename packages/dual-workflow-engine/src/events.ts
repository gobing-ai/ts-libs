/** Typed event map for workflow-engine run observability. All events prefixed `workflow.`. */
export type WorkflowEngineEvents = {
    /** Emitted when a run begins (inside the span). */
    'workflow.run.started': (data: { workflowName: string; mode: string; runId: string }) => void;
    /** Emitted when a run completes successfully. */
    'workflow.run.done': (data: { finalState: string; transitionsTaken: number }) => void;
    /** Emitted when a run fails. */
    'workflow.run.failed': (data: { finalState: string; reason: string }) => void;
    /** Emitted when entering a state or node. */
    'workflow.node.enter': (data: { node: string; transitionsTaken: number }) => void;
    /** Emitted on a state/node transition. */
    'workflow.node.transition': (data: { from: string; to: string; trigger: string | null }) => void;
    /** Emitted when an action starts executing. */
    'workflow.action.start': (data: { node: string; kind: string }) => void;
    /** Emitted when an action finishes executing (success or failure). */
    'workflow.action.done': (data: { node: string; kind: string; durationMs: number; ok: boolean }) => void;
    /** Emitted when a non-fatal action failure is continued past (onError: 'continue'). */
    'workflow.action.failed_continue': (data: { node: string; transitionsTaken: number; error?: string }) => void;
};
