import { FSMError } from './errors';
import type { WorkflowEngineHost } from './host';
import { allowedEnv, RunLifecycle, runtimeBuiltins } from './run-lifecycle';
import type {
    ActionDef,
    ActionResult,
    OnErrorPolicy,
    StateMachineWorkflowDef,
    WorkflowPersistenceAdapter,
    WorkflowRunOptions,
    WorkflowRunResult,
} from './types';
import { mergeVars, resolveOnErrorPolicy, resolveTemplates } from './variables';

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
        return await RunLifecycle.run(
            workflow.name,
            'state-machine',
            { persistence: this.options.persistence, events: options.events },
            options,
            (lifecycle) => this.loop(workflow, options, lifecycle),
        );
    }

    private async loop(
        workflow: StateMachineWorkflowDef,
        options: WorkflowRunOptions,
        lifecycle: RunLifecycle,
    ): Promise<WorkflowRunResult> {
        const runId = lifecycle.runId;
        const states = new Map(workflow.states.map((state) => [state.id, state]));
        const terminal = new Set(workflow.terminalStates ?? []);
        const vars = mergeVars(workflow.vars, options.vars);
        const env = allowedEnv(workflow.env?.allow ?? [], options.env);
        let current = states.get(workflow.initialState);
        let transitionsTaken = 0;
        let lastActionResult: ActionResult | undefined;
        const iterationBound = workflow.iterationBound ?? 50;
        const defaultOnError = workflow.defaultOnError;

        if (current === undefined) throw new FSMError(`Initial state "${workflow.initialState}" is not declared`);

        while (true) {
            // 1. Persist current state snapshot before work starts.
            await lifecycle.enter(current.id, transitionsTaken);

            // 2. Execute this state's on-enter actions in declaration order.
            const enter = await this.runActions(
                current.onEnter ?? [],
                workflow.name,
                current.id,
                runId,
                vars,
                env,
                options,
                transitionsTaken,
                lifecycle,
                defaultOnError,
            );
            // Retain the last action result (including failures the policy continued
            // past) so downstream guards can inspect it — matching the transition-flow
            // driver's `continue` semantics. A state with no enter actions must not
            // erase the previous result.
            if (enter.result !== undefined) lastActionResult = enter.result;
            // 3. Stop immediately when an action explicitly declares terminal success.
            if (enter.outcome === 'terminal') {
                return await lifecycle.done(current.id, transitionsTaken);
            }
            // 4. Halt only when an action failed under a 'fail' policy.
            if (enter.outcome === 'fail') {
                return await lifecycle.fail(current.id, transitionsTaken, lastActionResult?.error);
            }

            const outbound = workflow.transitions.filter((transition) => transition.from === current?.id);
            if (terminal.has(current.id) || outbound.length === 0) {
                return await lifecycle.done(current.id, transitionsTaken);
            }

            // 5. Evaluate transition guards in declaration order and pick the first passing transition.
            const nextTransition = await firstPassingTransition(outbound, this.options.host, {
                runId,
                current: current.id,
                vars,
                lastActionResult,
            });
            if (nextTransition === undefined) {
                return await lifecycle.fail(current.id, transitionsTaken, 'no-passing-transition');
            }

            // 6. Execute this state's on-exit actions before changing state.
            const exit = await this.runActions(
                current.onExit ?? [],
                workflow.name,
                current.id,
                runId,
                vars,
                env,
                options,
                transitionsTaken,
                lifecycle,
                defaultOnError,
            );
            if (exit.result !== undefined) lastActionResult = exit.result;
            if (exit.outcome === 'fail') return await lifecycle.fail(current.id, transitionsTaken, exit.result?.error);

            // 7. Persist transition and move to the target state.
            transitionsTaken += 1;
            await lifecycle.recordTransition(current.id, nextTransition.to, nextTransition.trigger ?? null);
            if (transitionsTaken > iterationBound) {
                return await lifecycle.fail(current.id, transitionsTaken, 'iteration-bound-exceeded');
            }
            const nextState = states.get(nextTransition.to);
            if (nextState === undefined) throw new FSMError(`Transition target "${nextTransition.to}" is not declared`);
            current = nextState;
        }
    }

    /**
     * Run a state's actions in order. Returns the last action result (retained even
     * when a failure was continued past, so downstream guards can inspect it) plus an
     * `outcome` discriminator: `terminal` (an action declared terminal success),
     * `fail` (a failure under a 'fail' policy — caller must halt), or `completed`.
     */
    private async runActions(
        actions: readonly ActionDef[],
        workflowName: string,
        stateId: string,
        runId: string,
        vars: Record<string, string>,
        env: Record<string, string>,
        options: WorkflowRunOptions,
        transitionsTaken: number,
        lifecycle: RunLifecycle,
        defaultOnError: OnErrorPolicy | undefined,
    ): Promise<RunActionsOutcome> {
        let last: ActionResult | undefined;
        for (const action of actions) {
            const resolved = resolveTemplates(action.options ?? {}, {
                vars,
                env,
                builtins: runtimeBuiltins(workflowName, stateId, runId, transitionsTaken, 'state-machine'),
            });
            const actionStartMs = Date.now();
            lifecycle.actionStart(stateId, action.kind);
            try {
                last = await this.options.host.runAction(action.kind, resolved, {
                    runId,
                    workdir: options.workdir,
                    stateOrNodeId: stateId,
                    vars,
                    env,
                    metadata: options.metadata,
                });
            } finally {
                lifecycle.actionDone(stateId, action.kind, Date.now() - actionStartMs, last?.ok ?? false);
            }
            if (last.terminal === true) return { outcome: 'terminal', result: last };
            if (!last.ok) {
                const policy = resolveOnErrorPolicy(action.onError, defaultOnError, options.onError);
                if (policy === 'fail') return { outcome: 'fail', result: last };
                lifecycle.warnActionFailed(stateId, transitionsTaken, last.error);
            }
        }
        return { outcome: 'completed', result: last };
    }
}

/** Result of running a state's actions: the last action result plus a control-flow discriminator. */
interface RunActionsOutcome {
    readonly outcome: 'completed' | 'terminal' | 'fail';
    readonly result: ActionResult | undefined;
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
