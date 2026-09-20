/**
 * The public decision surface — the only type callers see. `choice`, `score`,
 * and `noul` are implemented once, here, as `ask()` with a single-entry
 * question map; drivers implement `ask` and nothing else, so the sugar can
 * never drift from the batch path. This file imports no SDK (R9).
 */
import { getProcessEnv } from '@gobing-ai/ts-runtime';
import { DecisionConfigError } from './errors';
import type {
    AnswersFor,
    ChoiceAnswer,
    DecisionDriver,
    DecisionState,
    Desc,
    NoulAnswer,
    Question,
    ScoreAnswer,
} from './types';
import { q } from './types';
import { createTypesafeDriver } from './typesafe-driver';
import { validateAnswers, validateQuestions } from './validation';

/** Public decision surface: batch `ask` plus the three single-question sugar methods. */
export interface DecisionMaker {
    /** Name of the backing driver (e.g. `"typesafe"`, or a custom driver's name). */
    readonly driver: string;
    /** Evaluate N named questions against one shared state in a single driver request. */
    ask<const Q extends Record<string, Question>>(req: {
        state: DecisionState;
        questions: Q;
        model?: string;
    }): Promise<AnswersFor<Q>>;
    /** Pick one label. Sugar over `ask` with exactly one choice question. */
    choice<const L extends string>(
        state: DecisionState,
        prompt: Desc,
        labels: Record<L, Desc>,
    ): Promise<ChoiceAnswer<L>>;
    /** Score against a rubric. Sugar over `ask` with exactly one score question. */
    score(state: DecisionState, prompt: Desc, rubric: readonly [Desc, Desc, ...Desc[]]): Promise<ScoreAnswer>;
    /** Yes/no judgment. Sugar over `ask` with exactly one noul question. */
    noul(state: DecisionState, prompt?: Desc, outcomes?: { yes?: Desc; no?: Desc }): Promise<NoulAnswer>;
}

/** Factory options: driver selection, credential injection, and transport tuning. */
export interface DecisionMakerOptions {
    /** Custom driver — when supplied, the default TypeSafe driver is never constructed and no key is required. */
    driver?: DecisionDriver;
    /** Injected env record; defaults to `getProcessEnv()` (doctor-runner convention). */
    env?: Record<string, string | undefined>;
    /** Explicit key — wins over `env.TYPESAFE_API_KEY`. */
    apiKey?: string;
    /** Forwarded to the TypeSafe driver; default is the SDK's model default. */
    model?: string;
    baseURL?: string;
    timeoutMs?: number;
    maxRetries?: number;
    /** Injected fetch for tests. */
    fetch?: typeof fetch;
}

/**
 * Resolve the key per R7: `options.apiKey ?? (options.env ?? getProcessEnv()).TYPESAFE_API_KEY`.
 * Throws before any driver construction or request.
 */
function resolveApiKey(options: DecisionMakerOptions): string {
    const env = options.env ?? getProcessEnv();
    const apiKey = options.apiKey ?? env.TYPESAFE_API_KEY;
    if (!apiKey) {
        throw new DecisionConfigError(
            'Missing TYPESAFE_API_KEY — set it in the environment or pass options.apiKey.',
            'TYPESAFE_API_KEY',
        );
    }
    return apiKey;
}

/**
 * Build a DecisionMaker. `options.driver` wins when supplied; otherwise the
 * TypeSafe driver is constructed lazily on first use, after key resolution —
 * so a custom driver never requires a key and a missing key fails before any
 * request (R6/R7).
 */
export function createDecisionMaker(options: DecisionMakerOptions = {}): DecisionMaker {
    // Lazy driver slot: resolved on first use, at most once. A caller-supplied
    // driver never reaches key resolution or default-driver construction (R6).
    let defaultDriver: DecisionDriver | undefined;
    const resolveDriver = (): DecisionDriver => {
        if (options.driver) return options.driver;
        defaultDriver ??= createTypesafeDriver({
            apiKey: resolveApiKey(options),
            model: options.model,
            baseURL: options.baseURL,
            timeoutMs: options.timeoutMs,
            maxRetries: options.maxRetries,
            fetch: options.fetch,
        });
        return defaultDriver;
    };

    const ask = async <const Q extends Record<string, Question>>(req: {
        state: DecisionState;
        questions: Q;
        model?: string;
    }): Promise<AnswersFor<Q>> => {
        // R3: the questions map reaches the driver untouched — same reference,
        // no reordering, renaming, or dropping.
        const driver = resolveDriver();
        validateQuestions(req.questions);
        const answers = await driver.ask(req);
        validateAnswers(req.questions, answers);
        // Runtime validation above establishes each question/answer correspondence.
        return answers as AnswersFor<Q>;
    };

    return {
        driver: options.driver?.name ?? 'typesafe',
        ask,
        // R4/R5: each sugar method is one `ask` with exactly one `q.*` question,
        // unwrapping the single answer — no second driver call, no duplicated
        // request assembly.
        choice: (state, prompt, labels) =>
            ask({ state, questions: { question: q.choice(prompt, labels) } }).then((a) => a.question),
        score: (state, prompt, rubric) =>
            ask({ state, questions: { question: q.score(prompt, rubric) } }).then((a) => a.question),
        noul: (state, prompt, outcomes) =>
            ask({ state, questions: { question: q.noul(prompt, outcomes) } }).then((a) => a.question),
    };
}
