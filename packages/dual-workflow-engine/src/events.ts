/** Typed event map for workflow-engine run observability. All events prefixed `workflow.`. */
export type WorkflowEngineEvents = {
    /** Emitted when a run begins (inside the span). */
    'workflow.run.started': (data: { workflowName: string; mode: string; runId: string; dryRun: boolean }) => void;
    /** Emitted when a run completes successfully. */
    'workflow.run.done': (data: { runId: string; finalState: string; transitionsTaken: number }) => void;
    /** Emitted when a run fails. */
    'workflow.run.failed': (data: { runId: string; finalState: string; reason: string }) => void;
    /** Emitted when entering a state or node. */
    'workflow.node.enter': (data: { runId: string; node: string; transitionsTaken: number }) => void;
    /** Emitted on a state/node transition. */
    'workflow.node.transition': (data: { runId: string; from: string; to: string; trigger: string | null }) => void;
    /** Emitted when an action starts executing. */
    'workflow.action.start': (data: { runId: string; node: string; kind: string }) => void;
    /** Emitted when an action finishes executing (success or failure). */
    'workflow.action.done': (data: {
        runId: string;
        node: string;
        kind: string;
        durationMs: number;
        ok: boolean;
    }) => void;
    /** Emitted when a non-fatal action failure is continued past (onError: 'continue'). */
    'workflow.action.failed_continue': (data: {
        runId: string;
        node: string;
        transitionsTaken: number;
        error?: string;
    }) => void;
    /** Emitted by the builtin `event.emit` action for custom user-defined events. */
    'workflow.custom': (data: { name: string; payload: Record<string, unknown> }) => void;
    /** Emitted by the builtin `note` action for workflow-visible annotations. */
    'workflow.hitl.note': (data: { runId: string; node: string; message: string }) => void;
    /** Emitted when a guard condition is evaluated. Fires for every guard, including rejected ones. */
    'workflow.guard.evaluated': (data: {
        runId: string;
        from: string;
        to: string;
        kind: string;
        passed: boolean;
    }) => void;
    /** Emitted when an interactive HITL prompt is presented and the engine waits for input. */
    'workflow.hitl.ask': (data: { runId: string; node: string; kind: string; message: string }) => void;
    /** Emitted when an interactive HITL prompt receives a response. */
    'workflow.hitl.response': (data: { runId: string; node: string; ok: boolean }) => void;
};
