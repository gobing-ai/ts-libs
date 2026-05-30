import { loadWorkflowDef } from './config';
import type { WorkflowEngineHost } from './host';
import { StateMachineDriver } from './state-machine';
import { TransitionFlowDriver } from './transition-flow';
import type { WorkflowDef, WorkflowPersistenceAdapter, WorkflowRunOptions, WorkflowRunResult } from './types';

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
}
