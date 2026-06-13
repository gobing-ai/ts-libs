/** Error raised when workflow definition validation fails. */
export class WorkflowValidationError extends Error {
    constructor(
        message: string,
        readonly details?: unknown,
    ) {
        super(message);
        this.name = 'WorkflowValidationError';
    }
}

/** Error raised by the state-machine driver for invalid runtime state. */
export class FSMError extends Error {
    constructor(
        message: string,
        readonly details?: unknown,
    ) {
        super(message);
        this.name = 'FSMError';
    }
}

/** Error raised when a run id collides with an existing persisted run. */
export class RunCollisionError extends Error {
    constructor(runId: string) {
        super(`Workflow run "${runId}" already exists`);
        this.name = 'RunCollisionError';
    }
}

/** Error raised when attempting to resume a run that is not paused. */
export class WorkflowResumeError extends Error {
    constructor(
        message: string,
        readonly details?: unknown,
    ) {
        super(message);
        this.name = 'WorkflowResumeError';
    }
}
