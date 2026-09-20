import { DecisionBackendError, DecisionRequestError } from './errors';
import type { Question } from './types';

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function json(value: unknown, ancestors = new Set<unknown>()): boolean {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object' || ancestors.has(value)) return false;
    ancestors.add(value);
    const valid = Object.values(value).every((entry) => json(entry, ancestors));
    ancestors.delete(value);
    return valid;
}

function desc(value: unknown): boolean {
    return (value === null || typeof value === 'string' || typeof value === 'object') && json(value);
}

/** Validate caller data before either a custom driver or the SDK consumes it. */
export function validateQuestions(questions: unknown): asserts questions is Record<string, Question> {
    const fail: (name: string) => never = (name) => {
        throw new DecisionRequestError(`Invalid decision question: ${name}`, undefined, undefined);
    };
    if (!record(questions) || Object.keys(questions).length === 0) fail('expected a nonempty question map');
    for (const [name, question] of Object.entries(questions)) {
        if (!record(question)) fail(name);
        if (question.prompt !== undefined && !desc(question.prompt)) fail(name);
        switch (question.kind) {
            case 'choice':
                if (
                    !record(question.labels) ||
                    Object.keys(question.labels).length === 0 ||
                    !Object.values(question.labels).every(desc)
                )
                    fail(name);
                break;
            case 'score':
                if (
                    !Array.isArray(question.rubric) ||
                    question.rubric.length < 2 ||
                    !Array.from(question.rubric).every(desc)
                )
                    fail(name);
                break;
            case 'noul':
                if (
                    (question.yes !== undefined && !desc(question.yes)) ||
                    (question.no !== undefined && !desc(question.no))
                )
                    fail(name);
                break;
            default:
                fail(name);
        }
    }
}

function bounded(value: unknown, max = 1): boolean {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
}

function keysMatch(value: unknown, keys: string[]): value is Record<string, unknown> {
    return record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Verify the correspondence that permits the facade's typed answer narrowing. */
export function validateAnswers(questions: Record<string, Question>, answers: unknown): void {
    const fail: (name: string) => never = (name) => {
        throw new DecisionBackendError(`Invalid decision response: ${name}`, undefined);
    };
    if (!keysMatch(answers, Object.keys(questions))) fail('answer names do not match questions');
    for (const [name, question] of Object.entries(questions)) {
        const answer = answers[name];
        if (!record(answer) || answer.kind !== question.kind) fail(name);
        if (question.kind === 'noul') {
            if (!bounded(answer.probability)) fail(name);
            continue;
        }
        const keys =
            question.kind === 'choice' ? Object.keys(question.labels) : Array.from(question.rubric.keys(), String);
        if (
            !bounded(answer.confidence) ||
            !keysMatch(answer.probabilities, keys) ||
            !Object.values(answer.probabilities).every((p) => bounded(p))
        )
            fail(name);
        if (question.kind === 'choice') {
            if (typeof answer.label !== 'string' || !Object.hasOwn(question.labels, answer.label)) fail(name);
        } else if (
            !bounded(answer.score, question.rubric.length - 1) ||
            !keysMatch(answer.legend, keys) ||
            !Object.values(answer.legend).every(desc)
        ) {
            fail(name);
        }
    }
}
