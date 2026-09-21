/**
 * The local Laya decision driver satisfying {@link DecisionDriver} from `@gobing-ai/ts-ai-runner`.
 * Translates provider-neutral decision requests into the JSON-lines worker format
 * and maps worker answers back onto neutral {@link Answer} types (task 0078).
 */

import {
    type Answer,
    DecisionBackendError,
    type DecisionDriver,
    DecisionRequestError,
    type DecisionState,
    type Desc,
    type Question,
} from '@gobing-ai/ts-ai-runner';
import { LayaWorkerClient, type LayaWorkerClientOptions, type WorkerQuestion } from './worker-client';

/** Configuration options for {@link createLayaDriver}. */
export interface LayaDriverOptions extends LayaWorkerClientOptions {
    /** Pre-constructed worker client (useful for dependency injection in tests). */
    client?: LayaWorkerClient;
}

/** Format a {@link Desc} field into a string instructions value for the worker. */
function formatDesc(desc: Desc | undefined): string {
    if (typeof desc === 'string') return desc;
    if (desc === null || desc === undefined) return '';
    return JSON.stringify(desc);
}

/** Convert a neutral {@link Question} into the wire shape consumed by the worker. */
export function toWorkerQuestion(question: Question): WorkerQuestion {
    switch (question.kind) {
        case 'choice':
            return {
                type: 'choice',
                instructions: formatDesc(question.prompt),
                labels: question.labels,
                criteria: question.labels,
            };
        case 'score':
            return {
                type: 'score',
                instructions: formatDesc(question.prompt),
                rubric: question.rubric,
                // The runtime rejects a map here: score criteria is the rubric as a
                // nonempty list of descriptions (laya_mlx agent.py `_to_internal`).
                criteria: question.rubric.map(formatDesc),
            };
        case 'noul': {
            const outcomes =
                question.yes === undefined && question.no === undefined
                    ? undefined
                    : { true: question.yes ?? null, false: question.no ?? null };
            return {
                type: 'noul',
                instructions: formatDesc(question.prompt),
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
            const probabilities = (raw.probabilities ?? {}) as Record<string, number>;
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
                probabilities: normalizedProbs,
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
    const client = options.client ?? new LayaWorkerClient(options);

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
