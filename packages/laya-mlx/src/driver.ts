/**
 * The local Laya decision driver satisfying {@link DecisionDriver} from `@gobing-ai/ts-ai-runner`.
 * Translates provider-neutral decision requests into the laya-mlx question format
 * and maps answers back onto neutral {@link Answer} types (task 0078). Two MLX cores
 * serve the same wire shape: the Python worker (`mlx-python`) and the in-process
 * `@johnhenry/laya` port (`mlx-native`).
 */

import {
    type Answer,
    DecisionBackendError,
    DecisionConfigError,
    type DecisionDriver,
    DecisionRequestError,
    type DecisionState,
    type Desc,
    type Question,
} from '@gobing-ai/ts-ai-runner';
import { LayaNativeClient, type LayaNativeLoader } from './native-client';
import {
    LayaWorkerClient,
    type LayaWorkerClientOptions,
    type LayaWorkerResult,
    type WorkerQuestion,
} from './worker-client';

/**
 * Execution core behind `laya-local`. Both run Apple MLX on Metal:
 * - `mlx-python`: warm `laya-mlx` Python worker over JSON lines (default; needs a Python env).
 * - `mlx-native`: in-process `@johnhenry/laya` via libmlxc FFI (no Python).
 * - `auto`: try `mlx-native`, fall back to `mlx-python` when it cannot load.
 */
export type LayaCore = 'mlx-python' | 'mlx-native' | 'auto';

const LAYA_CORES: readonly LayaCore[] = ['mlx-python', 'mlx-native', 'auto'];

/** The `ask` surface both cores implement. */
export interface LayaClient {
    ask(state: string, questions: Record<string, WorkerQuestion>): Promise<LayaWorkerResult>;
    dispose(): void;
}

/** Configuration options for {@link createLayaDriver}. */
export interface LayaDriverOptions extends LayaWorkerClientOptions {
    /** Execution core. Default: `env.LAYA_CORE`, else `'mlx-python'`. */
    core?: LayaCore;
    /** Pre-constructed client (dependency injection in tests); bypasses core selection. */
    client?: LayaClient;
    /** Injected native loader (tests); forwarded to {@link LayaNativeClient}. */
    nativeLoader?: LayaNativeLoader;
}

/** Resolve the configured core: explicit option → injected `env.LAYA_CORE` → `'mlx-python'`. */
export function resolveLayaCore(options: Pick<LayaDriverOptions, 'core' | 'env'> = {}): LayaCore {
    const raw = options.core ?? (options.env?.LAYA_CORE || undefined) ?? 'mlx-python';
    if (!(LAYA_CORES as readonly string[]).includes(raw)) {
        throw new DecisionConfigError(
            `Unknown laya core '${raw}'; expected one of ${LAYA_CORES.join(', ')}`,
            'LAYA_CORE',
        );
    }
    return raw as LayaCore;
}

/**
 * `auto` core: the first ask probes `mlx-native` by loading the weights; any load
 * failure (missing libmlxc, unsupported option, bad checkpoint) falls back to the
 * Python worker for the client's lifetime. Request-time errors are not retried.
 */
class AutoLayaClient implements LayaClient {
    private active: Promise<LayaClient> | null = null;
    private resolved: LayaClient | null = null;
    private disposed = false;

    constructor(private readonly options: LayaDriverOptions) {}

    async ask(state: string, questions: Record<string, WorkerQuestion>): Promise<LayaWorkerResult> {
        this.active ??= this.select();
        return (await this.active).ask(state, questions);
    }

    dispose(): void {
        this.disposed = true;
        this.resolved?.dispose();
    }

    private async select(): Promise<LayaClient> {
        let chosen: LayaClient;
        try {
            const native = new LayaNativeClient({ ...this.options, loader: this.options.nativeLoader });
            try {
                await native.warm();
            } catch (error) {
                native.dispose();
                throw error;
            }
            chosen = native;
        } catch (error) {
            if (!(error instanceof DecisionConfigError)) throw error;
            chosen = new LayaWorkerClient(this.options);
        }
        this.resolved = chosen;
        // dispose() raced the native probe: the chosen client must not outlive us.
        if (this.disposed) chosen.dispose();
        return chosen;
    }
}

/** Construct the client for the resolved core. */
export function createLayaClient(options: LayaDriverOptions = {}): LayaClient {
    switch (resolveLayaCore(options)) {
        case 'mlx-native':
            return new LayaNativeClient({ ...options, loader: options.nativeLoader });
        case 'auto':
            return new AutoLayaClient(options);
        default:
            return new LayaWorkerClient(options);
    }
}

/** Format a {@link Desc} field into a string instructions value for the worker. */
function formatDesc(desc: Desc | undefined, fallback = ''): string {
    if (typeof desc === 'string') return desc.trim().length > 0 ? desc : fallback;
    if (desc === null || desc === undefined) return fallback;
    return JSON.stringify(desc);
}

/** Rescale a probability distribution to sum to exactly 1.0 when rounding error exceeds 1e-6. */
function normalizeDistribution<K extends string | number>(probs: Record<K, number>): Record<K, number> {
    const entries = Object.entries(probs) as [K, number][];
    const sum = entries.reduce<number>((s, [, p]) => s + (typeof p === 'number' && Number.isFinite(p) ? p : 0), 0);
    if (sum <= 0 || Math.abs(sum - 1) <= 1e-6) {
        return probs;
    }
    const result = {} as Record<K, number>;
    for (const [k, p] of entries) {
        result[k] = p / sum;
    }
    return result;
}

/** Convert a neutral {@link Question} into the wire shape consumed by the worker. */
export function toWorkerQuestion(question: Question): WorkerQuestion {
    switch (question.kind) {
        case 'choice':
            return {
                type: 'choice',
                instructions: formatDesc(question.prompt, 'Select the best matching option.'),
                labels: question.labels,
                criteria: question.labels,
            };
        case 'score':
            return {
                type: 'score',
                instructions: formatDesc(question.prompt, 'Evaluate according to the rubric.'),
                rubric: question.rubric,
                // The runtime rejects a map here: score criteria is the rubric as a
                // nonempty list of descriptions (laya_mlx agent.py `_to_internal`).
                criteria: question.rubric.map((r) => formatDesc(r, 'Level')),
            };
        case 'noul': {
            const outcomes =
                question.yes === undefined && question.no === undefined
                    ? undefined
                    : { true: question.yes ?? null, false: question.no ?? null };
            return {
                type: 'noul',
                instructions: formatDesc(question.prompt, 'Evaluate whether the proposition is true.'),
                ...(outcomes !== undefined ? { criteria: outcomes } : {}),
            };
        }
    }
}

/**
 * Map a raw worker answer onto the neutral {@link Answer} union (R2, R3, R4, R5).
 * Drops `action.act_probability` and `noul.confidence` deliberately per contract.
 */
export function mapWorkerAnswer(question: Question, rawAnswer: unknown): Answer {
    if (!rawAnswer || typeof rawAnswer !== 'object' || Array.isArray(rawAnswer)) {
        throw new DecisionBackendError('laya worker returned invalid answer: expected object', undefined);
    }
    const raw = rawAnswer as Record<string, unknown>;
    switch (question.kind) {
        case 'choice': {
            const label = raw.choice ?? raw.label;
            if (typeof label !== 'string' || label.length === 0) {
                throw new DecisionBackendError('laya worker returned invalid choice answer: missing label', undefined);
            }
            const confidence = typeof raw.confidence === 'number' ? raw.confidence : 0;
            const rawProbs = (raw.probabilities ?? {}) as Record<string, number>;
            const probabilities = normalizeDistribution(rawProbs);
            return {
                kind: 'choice',
                label,
                confidence,
                probabilities,
            };
        }
        case 'score': {
            const confidence = typeof raw.confidence === 'number' ? raw.confidence : 0;
            const legend: Record<number, Desc> = Object.fromEntries(question.rubric.map((desc, idx) => [idx, desc]));
            const rawLegend = raw.legend as Record<string | number, Desc> | undefined;
            const normalizedLegend: Record<number, Desc> = {};
            if (rawLegend) {
                for (const [k, v] of Object.entries(rawLegend)) {
                    normalizedLegend[Number(k)] = v;
                }
            }
            const rawProbs = (raw.probabilities ?? {}) as Record<string | number, number>;
            const normalizedProbs: Record<number, number> = {};
            for (const [k, v] of Object.entries(rawProbs)) {
                normalizedProbs[Number(k)] = v;
            }
            // The runtime reports score as the probability-weighted expectation
            // (e.g. 1.8451); the neutral contract is the categorical rubric index —
            // argmax over the per-level probabilities (validation.json semantics).
            const probEntries = Object.entries(normalizedProbs);
            let score: number;
            if (probEntries.length > 0) {
                score = Number(probEntries.reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0]);
            } else if (typeof raw.score === 'number' && Number.isFinite(raw.score)) {
                score = Math.round(raw.score);
            } else {
                throw new DecisionBackendError(
                    'laya worker returned invalid score answer: no score or probabilities',
                    undefined,
                );
            }
            return {
                kind: 'score',
                score,
                confidence,
                legend: rawLegend ? normalizedLegend : legend,
                probabilities: normalizeDistribution(normalizedProbs),
            };
        }
        case 'noul': {
            // R4: NoulAnswer carries a bare probability by contract; confidence is dropped.
            // R5: action.act_probability is dropped.
            const probability = typeof raw.noul === 'number' ? raw.noul : raw.probability;
            if (typeof probability !== 'number' || !Number.isFinite(probability)) {
                throw new DecisionBackendError(
                    'laya worker returned invalid noul answer: missing probability',
                    undefined,
                );
            }
            return {
                kind: 'noul',
                probability,
            };
        }
    }
}

/**
 * Build the local Laya decision driver satisfying {@link DecisionDriver} (R1).
 * Exposes a readonly `name: 'laya-local'` and a single `ask` method with no sugar.
 */
export function createLayaDriver(options: LayaDriverOptions = {}): DecisionDriver {
    const client = options.client ?? createLayaClient(options);

    return {
        name: 'laya-local',
        async ask({
            state,
            questions,
        }: {
            state: DecisionState;
            questions: Record<string, Question>;
        }): Promise<Record<string, Answer>> {
            if (!questions || typeof questions !== 'object' || Object.keys(questions).length === 0) {
                throw new DecisionRequestError('expected a nonempty question map', undefined, undefined);
            }
            const stateStr =
                typeof state === 'string' ? state : state === null || state === undefined ? '' : JSON.stringify(state);
            const workerQuestions: Record<string, WorkerQuestion> = Object.fromEntries(
                Object.entries(questions).map(([name, q]) => [name, toWorkerQuestion(q)]),
            );
            const result = await client.ask(stateStr, workerQuestions);
            if (!result?.answers || typeof result.answers !== 'object' || Array.isArray(result.answers)) {
                throw new DecisionBackendError('laya worker returned invalid result: expected answers map', undefined);
            }
            const answers: Record<string, Answer> = Object.fromEntries(
                Object.entries(questions).map(([name, q]) => {
                    const raw = result.answers[name];
                    if (raw === undefined) {
                        throw new DecisionBackendError(`laya worker missing answer for question '${name}'`, undefined);
                    }
                    return [name, mapWorkerAnswer(q, raw)];
                }),
            );
            return answers;
        },
    };
}
