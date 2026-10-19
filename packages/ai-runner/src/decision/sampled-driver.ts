/**
 * The engine-agnostic sampled-driver core (task 0114 R1, ADR-038): prompt
 * rendering, per-question enum options, answer parsing and frequency
 * estimation, shared by every backend that answers by drawing k samples from a
 * model. A backend supplies only the per-ask session hook.
 *
 * Pure by contract (R2): imports only the sibling `types` and `errors` modules —
 * no SDK, no workspace package, no platform API. That is what lets a driver
 * package outside `ts-ai-runner` build on it without a cycle.
 */

import { DecisionBackendError, DecisionRequestError } from './errors';
import type {
    Answer,
    ChoiceAnswer,
    DecisionDriver,
    DecisionState,
    Desc,
    NoulAnswer,
    Question,
    ScoreAnswer,
} from './types';

/**
 * Fixed instructions text. It never asks for confidence, certainty or a
 * probability — self-reported confidence would be fabricated calibration, which
 * the decision contract forbids (ADR-030).
 */
export const DECISION_INSTRUCTIONS =
    'You are a decision engine. Answer every question below using only the supplied state. ' +
    'For each question choose exactly one of the listed options. ' +
    'Reply with the JSON object the schema requires.';

/** The constrained-output schema over the whole question map (fm passes it to `fm respond --schema`). */
export interface EnumSchema {
    type: 'object';
    title: string;
    'x-order': string[];
    required: string[];
    additionalProperties: false;
    properties: Record<string, { type: 'string'; enum: string[] }>;
}

/** One ask's sampling session; opened once per ask and closed in `finally`. */
export interface SampleSession {
    /** Return one sample as a key → option-string record (parsed, not yet enum-checked). */
    sample(): Promise<Record<string, string>>;
    /** Release per-ask resources (temp schema file, scratch dir). Called on success and failure. */
    close?(): void | Promise<void>;
}

/** Configuration for {@link createSampledDriver}. */
export interface SampledDriverOptions {
    /** Driver name reported through `DecisionDriver.name`. */
    readonly name: string;
    /** Samples per ask. Default: 5. Ignored when `deterministic`. Positive integer. */
    readonly samples?: number;
    /** One sample; the sampler is expected to decode greedily. Default: false. */
    readonly deterministic?: boolean;
    /** Max samples in flight. Default: 1 (sequential). Positive integer. */
    readonly concurrency?: number;
    /** Prefix used in enum-violation messages. Default: `name` (fm passes `'fm'`). */
    readonly sampleLabel?: string;
    /** Open the per-ask session. Receives the rendered texts and the validated request. */
    open(ctx: {
        instructions: string;
        prompt: string;
        questions: Record<string, Question>;
        state: DecisionState;
        model?: string;
    }): Promise<SampleSession>;
    /** Override the default {@link DECISION_INSTRUCTIONS} text. */
    readonly instructions?: string;
}

/** A {@link DecisionDriver} built on sample frequencies, with the estimator it declares (ADR-030). */
export interface SampledDecisionDriver extends DecisionDriver {
    readonly estimator: { readonly kind: 'sample-frequency'; readonly samples: number; readonly greedy: boolean };
}

/** Build the enum schema over the whole question map: one call answers every key. */
export function buildEnumSchema(questions: Record<string, Question>): EnumSchema {
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

/**
 * Laya reference `confidence_from_probs` on the empirical distribution:
 * `1 − H(p) / ln(n)` over the n declared options. One-hot ⇒ 1, uniform ⇒ 0.
 */
export function entropyConfidence(probabilities: number[]): number {
    const n = probabilities.length;
    if (n <= 1) return 1;
    let entropy = 0;
    for (const p of probabilities) {
        if (p > 0) entropy -= p * Math.log(p);
    }
    return 1 - entropy / Math.log(n);
}

/**
 * Choice frequencies over every supplied label (unsampled ⇒ 0). The answer
 * label is the most frequent with ties broken by label declaration order.
 */
export function estimateChoice(labels: readonly string[], samples: readonly string[]): ChoiceAnswer<string> {
    const counts = new Map<string, number>(labels.map((label) => [label, 0]));
    for (const sample of samples) counts.set(sample, (counts.get(sample) ?? 0) + 1);
    const k = samples.length;
    const probabilities: Record<string, number> = {};
    const distribution: number[] = [];
    let bestLabel = labels[0] ?? '';
    let bestCount = -1;
    for (const label of labels) {
        const count = counts.get(label) ?? 0;
        const probability = count / k;
        distribution.push(probability);
        probabilities[label] = probability;
        // Declaration order wins ties: strict `>` keeps the earlier label.
        if (count > bestCount) {
            bestCount = count;
            bestLabel = label;
        }
    }
    return {
        kind: 'choice',
        label: bestLabel,
        confidence: entropyConfidence(distribution),
        probabilities,
    };
}

/**
 * Score frequencies over the level indices `0…n-1`. The answer score is the
 * most frequent level with ties going to the lower level; the legend maps each
 * index back to its rubric description.
 */
export function estimateScore(rubric: readonly Desc[], samples: readonly string[]): ScoreAnswer {
    const k = samples.length;
    const counts: number[] = [];
    for (const sample of samples) {
        const level = Number.parseInt(sample, 10);
        counts[level] = (counts[level] ?? 0) + 1;
    }
    const probabilities: Record<number, number> = {};
    const distribution: number[] = [];
    let bestLevel = 0;
    let bestCount = -1;
    for (let level = 0; level < rubric.length; level++) {
        const count = counts[level] ?? 0;
        const probability = count / k;
        distribution.push(probability);
        probabilities[level] = probability;
        // Lower level wins ties: strict `>` keeps the smaller index.
        if (count > bestCount) {
            bestCount = count;
            bestLevel = level;
        }
    }
    const legend: Record<number, Desc> = {};
    rubric.forEach((desc, level) => {
        legend[level] = desc;
    });
    return {
        kind: 'score',
        score: bestLevel,
        confidence: entropyConfidence(distribution),
        legend,
        probabilities,
    };
}

/** Noul is a bare yes-probability — no `confidence` key, by contract. */
export function estimateNoul(samples: readonly string[]): NoulAnswer {
    const yes = samples.filter((sample) => sample === 'yes').length;
    return { kind: 'noul', probability: yes / samples.length };
}

/** A parsed value outside the declared enum is a schema violation, never an answer. */
export function requireEnumValue(
    parsed: Record<string, string>,
    key: string,
    allowed: readonly string[],
    label = 'sample',
): string {
    const value = parsed[key];
    if (value === undefined || !allowed.includes(value)) {
        throw new DecisionBackendError(
            `${label} sample for '${key}' violates the schema enum: ${value === undefined ? '(missing)' : `'${value}'`}`,
            undefined,
        );
    }
    return value;
}

/** Parse text as JSON, reporting failure instead of throwing. */
function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
    try {
        return { ok: true, value: JSON.parse(text) };
    } catch {
        return { ok: false };
    }
}

/**
 * The first balanced `{…}` substring, scanned with a string/escape-aware brace
 * counter so braces inside string values do not close the object early.
 */
function firstBalancedObject(text: string): unknown {
    for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') {
                inString = true;
            } else if (ch === '{') {
                depth += 1;
            } else if (ch === '}') {
                depth -= 1;
                if (depth === 0) {
                    const parsed = tryParse(text.slice(start, i + 1));
                    if (parsed.ok) return parsed.value;
                    break;
                }
            }
        }
    }
    return undefined;
}

/**
 * Lenient answer parser for models without constrained decoding (task 0114 R6).
 * Tries the whole text, then the first fenced block, then the first balanced
 * object in prose. The result must be a flat object of string values.
 */
export function extractJsonAnswer(text: string): Record<string, string> {
    const direct = tryParse(text.trim());
    let value: unknown = direct.ok ? direct.value : undefined;

    if (value === undefined) {
        const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
        if (fence !== null) {
            const fenced = tryParse((fence[1] ?? '').trim());
            if (fenced.ok) value = fenced.value;
        }
    }
    if (value === undefined) value = firstBalancedObject(text);
    if (value === undefined) {
        throw new DecisionBackendError('no JSON object in sample output', undefined);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new DecisionBackendError(`sample output is not a JSON object: ${JSON.stringify(value)}`, undefined);
    }
    const record: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry !== 'string') {
            throw new DecisionBackendError(`sample output has a non-string value for '${key}'`, undefined);
        }
        record[key] = entry;
    }
    return record;
}

/**
 * Build a sampled driver: k draws through one per-ask {@link SampleSession},
 * enum-checked against the declared options and reduced to sample frequencies.
 *
 * The order inside `ask` is the contract (R5): validate → render → open →
 * sample → enum-check → estimate, with `close` in `finally` either way.
 */
export function createSampledDriver(options: SampledDriverOptions): SampledDecisionDriver {
    const { name, deterministic = false, sampleLabel } = options;
    const samples = options.samples ?? 5;
    const concurrency = options.concurrency ?? 1;

    if (!Number.isInteger(samples) || samples < 1) {
        throw new DecisionRequestError(`samples must be a positive integer; got ${samples}`, undefined, undefined);
    }
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new DecisionRequestError(
            `concurrency must be a positive integer; got ${concurrency}`,
            undefined,
            undefined,
        );
    }
    const k = deterministic ? 1 : samples;
    const label = sampleLabel ?? name;

    return {
        name,
        estimator: { kind: 'sample-frequency', samples: k, greedy: deterministic },

        async ask({
            state,
            questions,
            model,
        }: {
            state: DecisionState;
            questions: Record<string, Question>;
            model?: string;
        }): Promise<Record<string, Answer>> {
            const entries = Object.entries(questions);
            if (entries.length === 0) {
                throw new DecisionRequestError('expected a nonempty question map', undefined, undefined);
            }
            for (const [key, question] of entries) {
                const optionCount = declaredOptions(question).length;
                if (optionCount < 2) {
                    throw new DecisionRequestError(
                        `question '${key}' has fewer than two options (${optionCount})`,
                        undefined,
                        undefined,
                    );
                }
            }

            const instructions = options.instructions ?? DECISION_INSTRUCTIONS;
            const prompt = buildPrompt(state, questions);

            const session = await options.open({ instructions, prompt, questions, state, model });
            try {
                const draws: Array<Record<string, string>> = [];
                for (let start = 0; start < k; start += concurrency) {
                    const size = Math.min(concurrency, k - start);
                    const batch = Array.from({ length: size }, () => session.sample());
                    // allSettled awaits the whole batch before close; the first
                    // rejection in draw order wins, so no partial estimate escapes.
                    const settled = await Promise.allSettled(batch);
                    const failure = settled.find((result) => result.status === 'rejected');
                    if (failure !== undefined) throw (failure as PromiseRejectedResult).reason;
                    for (const result of settled) {
                        draws.push((result as PromiseFulfilledResult<Record<string, string>>).value);
                    }
                }

                const allowed = new Map(entries.map(([key, question]) => [key, declaredOptions(question)]));
                const samplesByKey = new Map(entries.map(([key]) => [key, [] as string[]]));
                for (const draw of draws) {
                    for (const [key] of entries) {
                        samplesByKey.get(key)?.push(requireEnumValue(draw, key, allowed.get(key) ?? [], label));
                    }
                }

                const answers: Record<string, Answer> = {};
                for (const [key, question] of entries) {
                    const values = samplesByKey.get(key) ?? [];
                    switch (question.kind) {
                        case 'choice':
                            answers[key] = estimateChoice(Object.keys(question.labels), values);
                            break;
                        case 'score':
                            answers[key] = estimateScore(question.rubric, values);
                            break;
                        case 'noul':
                            answers[key] = estimateNoul(values);
                            break;
                    }
                }
                return answers;
            } finally {
                await session.close?.();
            }
        },
    };
}
