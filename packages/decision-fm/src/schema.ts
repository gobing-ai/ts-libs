/**
 * fm request construction (task 0084 R3, design § Request construction):
 * the JSON schema passed to `fm respond --schema` and the instruction/prompt
 * texts passed via `-i` and as the final positional argument.
 *
 * The schema always carries `x-order` — a hand-written object schema without it
 * is rejected by `fm` ("The data couldn't be read because it is missing").
 * Score levels are string enums so every question uses the same constrained
 * string path; the driver converts them back to numbers.
 */

import type { DecisionState, Desc, Question } from '@gobing-ai/ts-ai-runner';

/**
 * Fixed `-i` instructions. It never asks for confidence, certainty or a
 * probability — self-reported confidence would be fabricated calibration,
 * which the decision contract forbids (ADR-030).
 */
export const FM_INSTRUCTIONS =
    'You are a decision engine. Answer every question below using only the supplied state. ' +
    'For each question choose exactly one of the listed options. ' +
    'Reply with the JSON object the schema requires.';

/** The JSON schema object handed to `fm respond --schema` (R3). */
export interface FmSchema {
    type: 'object';
    title: string;
    'x-order': string[];
    required: string[];
    additionalProperties: false;
    properties: Record<string, { type: 'string'; enum: string[] }>;
}

/** Build the fm schema over the whole question map: one call answers every key. */
export function buildFmSchema(questions: Record<string, Question>): FmSchema {
    const properties: Record<string, { type: 'string'; enum: string[] }> = {};
    for (const [key, question] of Object.entries(questions)) {
        switch (question.kind) {
            case 'choice':
                properties[key] = { type: 'string', enum: Object.keys(question.labels) };
                break;
            case 'score':
                properties[key] = { type: 'string', enum: question.rubric.map((_, level) => String(level)) };
                break;
            case 'noul':
                properties[key] = { type: 'string', enum: ['yes', 'no'] };
                break;
        }
    }
    const keys = Object.keys(questions);
    return {
        type: 'object',
        title: 'Decision',
        'x-order': keys,
        required: keys,
        additionalProperties: false,
        properties,
    };
}

/** Format a {@link Desc} into prompt text: strings verbatim, structured values JSON, absence empty. */
export function formatDesc(desc: Desc | undefined): string {
    if (typeof desc === 'string') return desc;
    if (desc === null || desc === undefined) return '';
    return JSON.stringify(desc);
}

/** The declared option values of a question, in declaration order (estimation + validation share this). */
export function declaredOptions(question: Question): string[] {
    switch (question.kind) {
        case 'choice':
            return Object.keys(question.labels);
        case 'score':
            return question.rubric.map((_, level) => String(level));
        case 'noul':
            return ['yes', 'no'];
    }
}

/**
 * Render the positional prompt: the state as text (JSON when structured), then
 * one block per question key with the prompt `Desc` and its options with
 * descriptions — choice label keys, score level indices with the rubric text,
 * noul `yes`/`no` with any outcome descriptions.
 */
export function buildPrompt(state: DecisionState, questions: Record<string, Question>): string {
    const parts: string[] = [];
    const stateText =
        typeof state === 'string' ? state : state === null || state === undefined ? '' : JSON.stringify(state);
    if (stateText.length > 0) parts.push(stateText);
    for (const [key, question] of Object.entries(questions)) {
        const lines: string[] = [];
        const prompt = formatDesc(question.prompt);
        lines.push(`Question "${key}":${prompt.length > 0 ? ` ${prompt}` : ''}`);
        lines.push('Options:');
        switch (question.kind) {
            case 'choice':
                for (const [label, desc] of Object.entries(question.labels)) {
                    const d = formatDesc(desc);
                    lines.push(d.length > 0 ? `- ${label}: ${d}` : `- ${label}`);
                }
                break;
            case 'score':
                question.rubric.forEach((desc, level) => {
                    const d = formatDesc(desc);
                    lines.push(d.length > 0 ? `- ${level}: ${d}` : `- ${level}`);
                });
                break;
            case 'noul': {
                for (const outcome of ['yes', 'no'] as const) {
                    const d = formatDesc(question[outcome]);
                    lines.push(d.length > 0 ? `- ${outcome}: ${d}` : `- ${outcome}`);
                }
                break;
            }
        }
        parts.push(lines.join('\n'));
    }
    return parts.join('\n\n');
}
