import type { WorkflowEngineHost } from './host';
import { defaultActionRedactor } from './persistence';
import type { RunLifecycle } from './run-lifecycle';
import { runtimeBuiltins, type WorkflowMode } from './run-lifecycle';
import type {
    ActionDef,
    ActionResult,
    OnErrorPolicy,
    Vars,
    WorkflowPersistenceAdapter,
    WorkflowRunOptions,
} from './types';
import { mergeSetVars, resolveOnErrorPolicy, resolveTemplates } from './variables';

/**
 * Outcome discriminator for a single action step. `terminal` means the action
 * declared terminal success (the run is done); `fail` means a failure under a
 * 'fail' policy (the caller must halt); `completed` means the step ran (possibly
 * a failure that the 'continue' policy logged past) and the loop may proceed.
 */
export type ActionStepOutcome = 'completed' | 'terminal' | 'fail';

/** Result of running one or more action steps: last result, a control-flow discriminator, and the accumulated `setVars` of every step in the sequence. */
export interface ActionStepResult {
    readonly outcome: ActionStepOutcome;
    readonly result: ActionResult | undefined;
    /**
     * Sequence-level accumulation of `setVars` from every action that ran
     * (including the terminal/failing one). Single-step callers get just that
     * step's setVars. Drivers merge this map into their run-local vars after
     * the sequence settles.
     */
    readonly setVars?: Vars;
}

/**
 * Everything an action step needs that does not change between the two drivers:
 * the host that owns the runner registry, the persistence sink, the lifecycle for
 * observability, plus the resolution inputs (vars/env/builtins source) and the
 * onError precedence chain. Drivers differ only in how many actions they feed in
 * and how they map the outcome onto their control loop — not in this mechanism.
 */
export interface ActionStepDeps {
    readonly host: WorkflowEngineHost;
    readonly persistence: WorkflowPersistenceAdapter;
    readonly lifecycle: RunLifecycle;
    readonly workflowName: string;
    readonly stateOrNodeId: string;
    readonly runId: string;
    readonly mode: WorkflowMode;
    readonly transitionsTaken: number;
    readonly env: Record<string, string>;
    readonly options: WorkflowRunOptions;
    readonly defaultOnError: OnErrorPolicy | undefined;
}

/**
 * Run one action through its full lifecycle: resolve templates, persist the
 * start row, time the host invocation inside try/finally, persist + emit the
 * finalize, then classify terminal/fail/continue. `vars` is read-only here;
 * callers thread any `setVars` from the returned result forward — the sequence
 * runner does so within a sequence, and drivers merge the accumulated map
 * across states/nodes (each dialect carries vars differently across its loop).
 *
 * This is the single seam both drivers share for action execution (ADR-006 §7
 * keeps the *control loops* dialect-specific; only this per-action mechanism is
 * shared). Returns the action result plus an outcome discriminator.
 */
export async function runActionStep(
    action: ActionDef,
    vars: Record<string, string>,
    deps: ActionStepDeps,
): Promise<ActionStepResult> {
    const { host, persistence, lifecycle, stateOrNodeId, runId } = deps;
    const resolved = resolveTemplates(action.options ?? {}, {
        vars,
        env: deps.env,
        builtins: runtimeBuiltins(deps.workflowName, stateOrNodeId, runId, deps.transitionsTaken, deps.mode),
    });
    const actionId = await persistence.saveActionStart(runId, stateOrNodeId, action.kind, resolved);
    const actionStartMs = Date.now();
    lifecycle.actionStart(stateOrNodeId, action.kind);
    let result: ActionResult | undefined;
    try {
        result = await host.runAction(action.kind, resolved, {
            runId,
            actionId,
            workdir: deps.options.workdir,
            stateOrNodeId,
            vars,
            env: deps.env,
            metadata: deps.options.metadata,
            events: deps.options.events,
        });
    } finally {
        const durationMs = Date.now() - actionStartMs;
        lifecycle.actionDone(stateOrNodeId, action.kind, durationMs, result?.ok ?? false);
        // Fire-and-forget the finalize write: the action row already exists (saveActionStart
        // was awaited), and finalize only updates audit fields — the run's correctness never
        // depends on it, so it must not block or fail the control loop. A swallowed `.catch`
        // keeps a rejected write from surfacing as an unhandledRejection (repo convention,
        // see runtime/process-executor.ts).
        void persistence
            .saveActionFinalize(
                actionId,
                result?.ok !== false ? 'done' : 'failed',
                durationMs,
                result?.ok ?? false,
                action.kind,
                result,
                deps.options.redactor ?? defaultActionRedactor,
            )
            .catch(() => undefined);
    }

    if (result.terminal === true) return { outcome: 'terminal', result };
    if (!result.ok) {
        const policy = resolveOnErrorPolicy(action.onError, deps.defaultOnError, deps.options.onError);
        if (policy === 'fail') return { outcome: 'fail', result };
        lifecycle.warnActionFailed(stateOrNodeId, deps.transitionsTaken, result.error);
    }
    return { outcome: 'completed', result };
}

/**
 * Run a sequence of actions in declaration order, stopping at the first
 * `terminal` or `fail` outcome. `setVars` from each action is threaded forward
 * BEFORE the next action runs, so action N+1 resolves its templates (and sees
 * `context.vars`) with every prior same-sequence `setVars` applied — the YAML
 * reads imperatively. The returned `setVars` accumulates the maps of every
 * action that ran (including a continued-past failure and the terminal/failing
 * action itself); it is the caller (the state-machine driver) that merges it
 * into run-local vars after the sequence settles. Returns the last action
 * result (retained even when a failure was continued past, so downstream
 * guards can inspect it) plus the controlling outcome.
 */
export async function runActionSequence(
    actions: readonly ActionDef[],
    vars: Record<string, string>,
    deps: ActionStepDeps,
): Promise<ActionStepResult> {
    let last: ActionResult | undefined;
    let acc: Vars | undefined;
    for (const action of actions) {
        const step = await runActionStep(action, vars, deps);
        if (step.result !== undefined) last = step.result;
        if (step.result?.setVars) {
            acc = mergeSetVars(acc ?? {}, step.result.setVars);
            vars = mergeSetVars(vars, step.result.setVars);
        }
        if (step.outcome === 'terminal') return { outcome: 'terminal', result: last, setVars: acc };
        if (step.outcome === 'fail') return { outcome: 'fail', result: last, setVars: acc };
    }
    return { outcome: 'completed', result: last, setVars: acc };
}
