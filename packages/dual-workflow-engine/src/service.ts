import { loadWorkflowDef } from './config';
import { FSMError } from './errors';
import type { WorkflowEngineHost } from './host';
import { StateMachineDriver } from './state-machine';
import { TransitionFlowDriver } from './transition-flow';
import type {
    WorkflowDef,
    WorkflowPersistenceAdapter,
    WorkflowRunOptions,
    WorkflowRunRecord,
    WorkflowRunResult,
} from './types';

/** High-level workflow service for loading, running, and listing persisted workflow runs. */
export class WorkflowService {
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
        const workflow = typeof workflowOrRunId === 'string' ? undefined : workflowOrRunId;
        const runId = typeof workflowOrRunId === 'string' ? workflowOrRunId : runIdOrNewState;
        const newState = typeof workflowOrRunId === 'string' ? runIdOrNewState : (newStateOrOptions as string);
        const options =
            typeof workflowOrRunId === 'string' ? (newStateOrOptions as WorkflowRunOptions | undefined) : maybeOptions;

        if (workflow !== undefined) {
            if (workflow.kind === 'transition-flow')
                throw new FSMError('reseedRun only supports state-machine workflows');
            if (!workflow.states.some((state) => state.id === newState)) {
                throw new FSMError(`Cannot reseed run "${runId}" to undeclared state "${newState}"`);
            }
        }

        const result = await this.persistence.reseedRun(runId, newState);
        void options?.events?.emit('workflow.run.reseeded', {
            runId,
            fromState: result.fromState ?? '',
            toState: result.toState,
        });
    }
}
