import { FSMError } from './errors';
import type { WorkflowEngineHost } from './host';
import type {
    ActionDef,
    ActionResult,
    StateMachineWorkflowDef,
    WorkflowPersistenceAdapter,
    WorkflowRunOptions,
    WorkflowRunRecord,
    WorkflowRunResult,
} from './types';
import { mergeVars, resolveTemplates } from './variables';

/** Dependencies required by the state-machine driver. */
export interface StateMachineDriverOptions {
    readonly host: WorkflowEngineHost;
    readonly persistence: WorkflowPersistenceAdapter;
}

/** State-machine workflow driver with an R7 single control function. */
export class StateMachineDriver {
    constructor(private readonly options: StateMachineDriverOptions) {}

    /** Run a state-machine workflow to completion or failure. */
    async run(workflow: StateMachineWorkflowDef, options: WorkflowRunOptions = {}): Promise<WorkflowRunResult> {
        const runId = options.runId ?? crypto.randomUUID();
        const startedAt = new Date().toISOString();
        const mode = 'state-machine';
        await this.options.persistence.createRun(runRecord(runId, workflow.name, mode, startedAt, options.metadata));

        const states = new Map(workflow.states.map((state) => [state.id, state]));
        const terminal = new Set(workflow.terminalStates ?? []);
        const vars = mergeVars(workflow.vars, options.vars);
        const env = allowedEnv(workflow.env?.allow ?? [], options.env ?? process.env);
        let current = states.get(workflow.initialState);
        let transitionsTaken = 0;
        let lastActionResult: ActionResult | undefined;
        const iterationBound = workflow.iterationBound ?? 50;

        if (current === undefined) throw new FSMError(`Initial state "${workflow.initialState}" is not declared`);

        while (true) {
            // 1. Persist current state snapshot before work starts.
            await this.options.persistence.saveWorkflowState(runId, current.id, { transitionsTaken });
            await this.options.persistence.savePhase(runId, current.id, 'running');

            // 2. Execute this state's on-enter actions in declaration order.
            lastActionResult = await this.runActions(
                current.onEnter ?? [],
                workflow.name,
                current.id,
                runId,
                vars,
                env,
                options,
            );
            if (lastActionResult?.ok === false)
                return await this.fail(
                    runId,
                    workflow.name,
                    mode,
                    current.id,
                    transitionsTaken,
                    lastActionResult.error,
                );

            // 3. Stop immediately when an action explicitly declares terminal success.
            if (lastActionResult?.terminal === true) {
                return await this.done(runId, workflow.name, mode, current.id, transitionsTaken);
            }

            // 4. Stop when the current state is terminal or has no outbound transitions.
            const outbound = workflow.transitions.filter((transition) => transition.from === current?.id);
            if (terminal.has(current.id) || outbound.length === 0) {
                return await this.done(runId, workflow.name, mode, current.id, transitionsTaken);
            }

            // 5. Evaluate transition guards in declaration order and pick the first passing transition.
            const nextTransition = await firstPassingTransition(outbound, this.options.host, {
                runId,
                current: current.id,
                vars,
                lastActionResult,
            });
            if (nextTransition === undefined) {
                return await this.fail(
                    runId,
                    workflow.name,
                    mode,
                    current.id,
                    transitionsTaken,
                    'no-passing-transition',
                );
            }

            // 6. Execute this state's on-exit actions before changing state.
            const exitResult = await this.runActions(
                current.onExit ?? [],
                workflow.name,
                current.id,
                runId,
                vars,
                env,
                options,
            );
            if (exitResult?.ok === false)
                return await this.fail(runId, workflow.name, mode, current.id, transitionsTaken, exitResult.error);

            // 7. Persist transition and move to the target state.
            transitionsTaken += 1;
            await this.options.persistence.saveTransition(
                runId,
                current.id,
                nextTransition.to,
                nextTransition.trigger ?? null,
            );
            if (transitionsTaken > iterationBound) {
                return await this.fail(
                    runId,
                    workflow.name,
                    mode,
                    current.id,
                    transitionsTaken,
                    'iteration-bound-exceeded',
                );
            }
            const nextState = states.get(nextTransition.to);
            if (nextState === undefined) throw new FSMError(`Transition target "${nextTransition.to}" is not declared`);
            current = nextState;
        }
    }

    private async runActions(
        actions: readonly ActionDef[],
        workflowName: string,
        stateId: string,
        runId: string,
        vars: Record<string, string>,
        env: Record<string, string>,
        options: WorkflowRunOptions,
    ): Promise<ActionResult | undefined> {
        let last: ActionResult | undefined;
        for (const action of actions) {
            const resolved = resolveTemplates(action.options ?? {}, {
                vars,
                env,
                builtins: { workflow: workflowName, state: stateId, runId },
            });
            last = await this.options.host.runAction(action.kind, resolved, {
                runId,
                workdir: options.workdir,
                stateOrNodeId: stateId,
                vars,
                env,
                metadata: options.metadata,
            });
            if (!last.ok || last.terminal === true) return last;
        }
        return last;
    }

    private async done(
        runId: string,
        workflowName: string,
        mode: 'state-machine',
        finalState: string,
        transitionsTaken: number,
    ): Promise<WorkflowRunResult> {
        await this.options.persistence.savePhase(runId, finalState, 'done');
        await this.options.persistence.finalizeRun(runId, 'done', new Date().toISOString());
        return { runId, workflowName, mode, status: 'done', finalState, transitionsTaken };
    }

    private async fail(
        runId: string,
        workflowName: string,
        mode: 'state-machine',
        finalState: string,
        transitionsTaken: number,
        reason = 'failed',
    ): Promise<WorkflowRunResult> {
        await this.options.persistence.savePhase(runId, finalState, 'failed');
        await this.options.persistence.finalizeRun(runId, 'failed', new Date().toISOString());
        return { runId, workflowName, mode, status: 'failed', finalState, transitionsTaken, reason };
    }
}

async function firstPassingTransition(
    transitions: StateMachineWorkflowDef['transitions'],
    host: WorkflowEngineHost,
    context: Parameters<WorkflowEngineHost['evaluateGuard']>[2],
): Promise<StateMachineWorkflowDef['transitions'][number] | undefined> {
    for (const transition of transitions) {
        if (transition.guard === undefined) return transition;
        if (await host.evaluateGuard(transition.guard.kind, transition.guard.options ?? {}, context)) return transition;
    }
    return undefined;
}

function allowedEnv(names: readonly string[], source: Record<string, string | undefined>): Record<string, string> {
    return Object.fromEntries(
        names.flatMap((name) => (source[name] === undefined ? [] : [[name, source[name] as string]])),
    );
}

function runRecord(
    runId: string,
    workflowName: string,
    mode: string,
    startedAt: string,
    metadata: unknown,
): WorkflowRunRecord {
    return {
        id: runId,
        workflow_name: workflowName,
        mode,
        status: 'running',
        started_at: startedAt,
        completed_at: null,
        metadata_json: JSON.stringify(metadata ?? {}),
    };
}
