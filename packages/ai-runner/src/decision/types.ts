/**
 * Provider-neutral decision vocabulary — deliberately not re-exported from
 * `@typesafe-ai/sdk`. Re-exporting the SDK's response types would bind every
 * caller to the vendor; the neutral names here (`kind`, `labels`, `rubric`,
 * `probability`) keep vendor mapping explicit and confined to the driver.
 * This file imports nothing — no SDK, no workspace package (boundary rule).
 */

/** Any JSON-serializable value. */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Caller-supplied decision context: free text, a structured object, or a list. */
export type DecisionState = string | Json[] | { [k: string]: Json } | null;

/** A description; `null` means "left undescribed" (e.g. a label needing no rationale). */
export type Desc = string | Json[] | { [k: string]: Json } | null;

/** Pick one label from a fixed set. Labels are the answer's type parameter. */
export type ChoiceQuestion<L extends string> = { kind: 'choice'; prompt?: Desc; labels: Record<L, Desc> };

/** Score against a rubric; at least two levels, enforced at compile time. */
export type ScoreQuestion = { kind: 'score'; prompt?: Desc; rubric: readonly [Desc, Desc, ...Desc[]] };

/** Binary yes/no judgment with optional per-outcome descriptions. */
export type NoulQuestion = { kind: 'noul'; prompt?: Desc; yes?: Desc; no?: Desc };

/** Any question the decision surface accepts. */
export type Question = ChoiceQuestion<string> | ScoreQuestion | NoulQuestion;

/** Selected label, calibration confidence, and a probability per label. */
export type ChoiceAnswer<L extends string> = {
    kind: 'choice';
    label: L;
    confidence: number;
    probabilities: Record<L, number>;
};

/** Rubric score, confidence, per-level legend, and a probability per level. */
export type ScoreAnswer = {
    kind: 'score';
    score: number;
    confidence: number;
    legend: Record<number, Desc>;
    probabilities: Record<number, number>;
};

/**
 * Bare yes-probability — no `confidence`, on purpose. The wire response
 * returns only a probability; synthesizing a confidence would fabricate
 * calibration data. The asymmetry is load-bearing: later code cannot paper
 * over it.
 */
export type NoulAnswer = { kind: 'noul'; probability: number };

/** Any answer the decision surface returns — discriminate on `kind`. */
export type Answer = ChoiceAnswer<string> | ScoreAnswer | NoulAnswer;

/** The answer type a question of shape `Q` decodes to. */
export type AnswerFor<Q> =
    Q extends ChoiceQuestion<infer L>
        ? ChoiceAnswer<L>
        : Q extends ScoreQuestion
          ? ScoreAnswer
          : Q extends NoulQuestion
            ? NoulAnswer
            : never;

/** Conditional answer record for a keyed question map. */
export type AnswersFor<Q extends Record<string, Question>> = { readonly [K in keyof Q]: AnswerFor<Q[K]> };

/**
 * Question builders for the batch path. Namespaced under `q` because
 * `choice` / `score` / `noul` are already `DecisionMaker` method names.
 */
export const q = {
    /**
     * Build a choice question. `const` on the type parameter keeps an inline
     * label map from widening to `string` — the caller keeps the union.
     */
    choice: <const L extends string>(prompt: Desc, labels: Record<L, Desc>): ChoiceQuestion<L> => ({
        kind: 'choice',
        prompt,
        labels,
    }),
    /** Build a score question from a rubric of at least two levels. */
    score: (prompt: Desc, rubric: readonly [Desc, Desc, ...Desc[]]): ScoreQuestion => ({
        kind: 'score',
        prompt,
        rubric,
    }),
    /** Build a yes/no question; outcomes are optional and default undescribed. */
    noul: (prompt?: Desc, outcomes?: { yes?: Desc; no?: Desc }): NoulQuestion => ({
        kind: 'noul',
        prompt,
        ...outcomes,
    }),
};

/**
 * The one-method internal seam every backend driver implements. The loose
 * `Record<string, Answer>` return is narrowed to `AnswersFor<Q>` by a single
 * documented cast at the facade boundary — drivers stay trivial to write.
 */
export interface DecisionDriver {
    readonly name: string;
    ask(req: {
        state: DecisionState;
        questions: Record<string, Question>;
        model?: string;
    }): Promise<Record<string, Answer>>;
}
