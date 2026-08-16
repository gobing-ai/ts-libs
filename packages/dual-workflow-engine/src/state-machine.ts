import { runActionSequence } from './action-step';
import { FSMError } from './errors';
import type { WorkflowEngineHost } from './host';
import { allowedEnv, RunLifecycle } from './run-lifecycle';
import type {
    ActionResult,
    StateMachineWorkflowDef,
    WorkflowPersistenceAdapter,
    WorkflowRunOptions,
    WorkflowRunResult,
} from './types';
import { mergeSetVars, mergeVars, resolveTemplates } from './variables';

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

    /** Resume a paused state-machine run from the given state, skipping on-enter. */
    async resume(
        workflow: StateMachineWorkflowDef,
        runId: string,
        resumeFromState: string,
        externalKey: string | undefined,
        options: WorkflowRunOptions = {},
    ): Promise<WorkflowRunResult> {
        return await RunLifecycle.resume(
            workflow.name,
            'state-machine',
            { persistence: this.options.persistence, events: options.events },
            runId,
            externalKey,
            (lifecycle) => this.loop(workflow, options, lifecycle, resumeFromState),
        );
    }

    private async loop(
        workflow: StateMachineWorkflowDef,
        options: WorkflowRunOptions,
        lifecycle: RunLifecycle,
        resumeFromState?: string,
    ): Promise<WorkflowRunResult> {
        const runId = lifecycle.runId;
        const states = new Map(workflow.states.map((state) => [state.id, state]));
        const terminal = new Set(workflow.terminalStates ?? []);
        const failure = new Set(workflow.failureStates ?? []);
        let vars = mergeVars(workflow.vars, options.vars);
        const env = allowedEnv(workflow.env?.allow ?? [], options.env);
        let current = resumeFromState !== undefined ? states.get(resumeFromState) : states.get(workflow.initialState);
        let transitionsTaken = 0;
        let lastActionResult: ActionResult | undefined;
        const iterationBound = workflow.iterationBound ?? 50;
        const defaultOnError = workflow.defaultOnError;
        let isResume = resumeFromState !== undefined;
        // When `commitHop` has already persisted the new state's snapshot +
        // phase atomically (every iteration after the first), `enter` must skip
        // the persist half to avoid duplicate INSERT rows (ADR-020).
        let persistedViaHop = false;

        if (current === undefined) {
            const label = resumeFromState ?? workflow.initialState;
            throw new FSMError(`State "${label}" is not declared`);
        }

        while (true) {
            if (isResume) {
                // Resume: skip enter actions on the first iteration (already ran before pause).
                isResume = false;
                persistedViaHop = true; // state already persisted before the pause
            } else {
                // 1. Persist current state snapshot before work starts (skipped when
                //    commitHop already persisted it atomically on the previous hop).
                await lifecycle.enter(current.id, transitionsTaken, !persistedViaHop, vars);

                // 2. Execute this state's on-enter actions in declaration order.
                const enter = options.dryRun
                    ? EMPTY_OUTCOME
                    : await runActionSequence(current.onEnter ?? [], vars, {
                          host: this.options.host,
                          persistence: this.options.persistence,
                          lifecycle,
                          workflowName: workflow.name,
                          stateOrNodeId: current.id,
                          runId,
                          mode: 'state-machine',
                          transitionsTaken,
                          env,
                          options,
                          defaultOnError,
                      });
                // Retain the last action result (including failures the policy continued
                // past) so downstream guards can inspect it — matching the transition-flow
                // driver's `continue` semantics. A state with no enter actions must not
                // erase the previous result.
                if (enter.result !== undefined) lastActionResult = enter.result;
                if (enter.setVars) vars = mergeSetVars(vars, enter.setVars);
                if (enter.outcome === 'terminal') {
                    return failure.has(current.id)
                        ? await lifecycle.fail(current.id, transitionsTaken, `terminal:${current.id}`)
                        : await lifecycle.done(current.id, transitionsTaken);
                }
                // 4. Halt only when an action failed under a 'fail' policy.
                if (enter.outcome === 'fail') {
                    return await lifecycle.fail(current.id, transitionsTaken, lastActionResult?.error);
                }

                // Pause: if the state declares pause, stop advancing and persist the paused position.
                if (current.pause === true) {
                    return await lifecycle.pause(current.id, transitionsTaken, vars);
                }
            }

            const outbound = workflow.transitions.filter((transition) => transition.from === current?.id);
            if (terminal.has(current.id) || outbound.length === 0) {
                return failure.has(current.id)
                    ? await lifecycle.fail(current.id, transitionsTaken, `terminal:${current.id}`)
                    : await lifecycle.done(current.id, transitionsTaken);
            }

            // 5. Evaluate transition guards in declaration order and pick the first passing transition.
            const nextTransition = await firstPassingTransition(
                outbound,
                this.options.host,
                {
                    runId,
                    current: current.id,
                    vars,
                    lastActionResult,
                    // Shell guards use relative paths (e.g. .spur/run/${vars.__runId}-*) —
                    // must share the run's workdir with actions or they read the process cwd.
                    workdir: options.workdir,
                },
                lifecycle,
            );

            if (nextTransition === undefined) {
                return await lifecycle.fail(current.id, transitionsTaken, 'no-passing-transition');
            }

            // 6. Execute this state's on-exit actions before changing state.
            const exit = options.dryRun
                ? EMPTY_OUTCOME
                : await runActionSequence(current.onExit ?? [], vars, {
                      host: this.options.host,
                      persistence: this.options.persistence,
                      lifecycle,
                      workflowName: workflow.name,
                      stateOrNodeId: current.id,
                      runId,
                      mode: 'state-machine',
                      transitionsTaken,
                      env,
                      options,
                      defaultOnError,
                  });
            if (exit.result !== undefined) lastActionResult = exit.result;
            if (exit.setVars) vars = mergeSetVars(vars, exit.setVars);
            if (exit.outcome === 'fail') return await lifecycle.fail(current.id, transitionsTaken, exit.result?.error);

            // 7. Atomically commit the transition + new state snapshot + phase in a
            //    single batch (ADR-020). The next iteration's `enter` becomes
            //    observe-only; a crash between writes is now impossible.
            transitionsTaken += 1;
            await lifecycle.commitHop(
                current.id,
                nextTransition.to,
                nextTransition.trigger ?? null,
                transitionsTaken,
                {
                    phase: nextTransition.to,
                    status: 'running',
                },
                vars,
            );
            if (transitionsTaken > iterationBound) {
                return await lifecycle.fail(current.id, transitionsTaken, 'iteration-bound-exceeded');
            }
            const nextState = states.get(nextTransition.to);
            if (nextState === undefined) throw new FSMError(`Transition target "${nextTransition.to}" is not declared`);
            current = nextState;
            persistedViaHop = true;
        }
    }
}

/** Dry-run sentinel: no action ran, so there is nothing to retain and nothing to halt on. */
const EMPTY_OUTCOME = { outcome: 'completed', result: undefined, setVars: undefined } as const;

async function firstPassingTransition(
    transitions: StateMachineWorkflowDef['transitions'],
    host: WorkflowEngineHost,
    context: Parameters<WorkflowEngineHost['evaluateGuard']>[2],
    lifecycle: RunLifecycle,
): Promise<StateMachineWorkflowDef['transitions'][number] | undefined> {
    for (const transition of transitions) {
        if (transition.guard === undefined) return transition;
        // Resolve ${vars.*} templates in guard options before evaluation — guards use the
        // same var interpolation as actions (e.g. `spur task check ${vars.wbs}`).
        const resolvedOptions = resolveTemplates(transition.guard.options ?? {}, {
            vars: context.vars,
            env: {},
        });
        const passed = await host.evaluateGuard(transition.guard.kind, resolvedOptions, context);
        lifecycle.guardEvaluated(context.current, transition.to, transition.guard.kind, passed);
        if (passed) return transition;
    }
    return undefined;
}
