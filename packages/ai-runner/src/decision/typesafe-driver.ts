/**
 * The TypeSafe backend driver — the only decision file that imports
 * `@typesafe-ai/sdk` (0069 pin). Client wiring (R1/R2), neutral⇄SDK question
 * and answer mapping (R4/R5), and the error translation table (R7) live here;
 * everything above this file stays vendor-neutral.
 */

import type { Question as SdkQuestion, ResultFor as SdkResultFor, SystemOneResult } from '@typesafe-ai/sdk';
import {
    APIConnectionError,
    APIError,
    APITimeoutError,
    AuthenticationError,
    choice,
    noul,
    PermissionDeniedError,
    RateLimitError,
    score,
    TypeSafeClient,
    TypeSafeError,
} from '@typesafe-ai/sdk';
import {
    DecisionAuthError,
    DecisionBackendError,
    DecisionConnectionError,
    DecisionRateLimitError,
    DecisionRequestError,
    DecisionTimeoutError,
} from './errors';
import type { Answer, DecisionDriver, Question } from './types';
import { validateAnswers, validateQuestions } from './validation';

/** Configuration the facade resolves (key per R7) and forwards to the TypeSafe driver. */
export interface TypesafeDriverConfig {
    apiKey: string;
    model?: string;
    baseURL?: string;
    timeoutMs?: number;
    maxRetries?: number;
    fetch?: typeof fetch;
}

/**
 * Build the TypeSafe driver: exactly one `TypeSafeClient` per driver instance
 * (R2), the API key always passed explicitly so the SDK's `TYPESAFE_API_KEY`
 * self-resolution never runs (R1). All transport failures — at construction
 * or at ask time — come back as `DecisionError`s, never SDK classes (R7).
 */
export function createTypesafeDriver(config: TypesafeDriverConfig): DecisionDriver {
    let client: TypeSafeClient;
    try {
        client = new TypeSafeClient({
            apiKey: config.apiKey,
            // baseURL is forwarded as-is. SDK 0.6.0 exports no default
            // base-URL constant (`ENV` holds env-var names only), so an
            // omitted baseURL still lets the SDK self-resolve
            // `TYPESAFE_BASE_URL` — documented residual for 0073.
            baseURL: config.baseURL,
            defaultModel: config.model,
            timeout: config.timeoutMs,
            retry: config.maxRetries === undefined ? undefined : { maxRetries: config.maxRetries },
            fetch: config.fetch,
        });
    } catch (err) {
        translateError(err);
    }

    return {
        name: 'typesafe',
        async ask({ state, questions, model }) {
            validateQuestions(questions);
            let result: SystemOneResult<Record<string, SdkQuestion>>;
            try {
                const sdkQuestions = Object.fromEntries(
                    Object.entries(questions).map(([name, question]) => [name, toSdkQuestion(question)]),
                );
                result = await client.systemOne({ state, questions: sdkQuestions, model });
            } catch (err) {
                translateError(err);
            }

            // R6: the SDK echoes the request's question names, so the mapped
            // record keeps the caller's keys in correspondence. R8: `model`
            // and `usage` on the result are deliberately not surfaced.
            if (!result?.answers || typeof result.answers !== 'object' || Array.isArray(result.answers)) {
                throw new DecisionBackendError('Invalid decision response: expected answers map', undefined);
            }
            const answers = Object.fromEntries(
                Object.entries(result.answers).map(([name, answer]) => [name, fromSdkAnswer(answer)]),
            );
            validateAnswers(questions, answers);
            return answers;
        },
    };
}

/** Neutral question → SDK wire question (R4). `null` is "undescribed" on the wire. */
function toSdkQuestion(question: Question): SdkQuestion {
    switch (question.kind) {
        case 'choice':
            return choice(question.prompt ?? null, question.labels);
        case 'score':
            return score(question.prompt ?? null, question.rubric);
        case 'noul': {
            const outcomes =
                question.yes === undefined && question.no === undefined
                    ? undefined
                    : { true: question.yes, false: question.no };
            return noul(question.prompt ?? null, outcomes);
        }
    }
}

/** SDK wire response → neutral answer (R5). Noul gets no confidence — the wire has none and none is invented. */
function fromSdkAnswer(answer: SdkResultFor<SdkQuestion>): Answer {
    if (!answer || typeof answer !== 'object')
        throw new DecisionBackendError('Invalid decision response: expected answer object', undefined);
    switch (answer.type) {
        case 'choice':
            return {
                kind: 'choice',
                label: answer.choice,
                confidence: answer.confidence,
                probabilities: answer.probabilities,
            };
        case 'score':
            return {
                kind: 'score',
                score: answer.score,
                confidence: answer.confidence,
                legend: answer.legend,
                probabilities: answer.probabilities,
            };
        case 'noul':
            return { kind: 'noul', probability: answer.noul };
        default:
            throw new DecisionBackendError('Invalid decision response: unknown answer kind', undefined);
    }
}

/**
 * R7, per the design doc's error table. Ordered subclass-before-base:
 * `APITimeoutError` extends `APIConnectionError`, and the HTTP subclasses
 * extend `APIError`. Rows the table does not name fall to the nearest home:
 * 4xx (`NotFoundError` included) is a `DecisionRequestError`, and any local
 * `TypeSafeError` (empty questions, invalid client config) lands there too
 * with `status: undefined` — so no SDK class ever escapes. Foreign errors are
 * rethrown untouched; they are not this package's to translate.
 */
function translateError(err: unknown): never {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof RateLimitError) {
        throw new DecisionRateLimitError(message, err.status, err.retryAfterMs, { cause: err });
    }
    if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
        throw new DecisionAuthError(message, err.status, { cause: err });
    }
    if (err instanceof APITimeoutError) {
        throw new DecisionTimeoutError(message, err.timeoutMs, { cause: err });
    }
    if (err instanceof APIConnectionError) {
        throw new DecisionConnectionError(message, { cause: err });
    }
    if (err instanceof APIError) {
        if (err.status < 500) {
            const raw = typeof err.body === 'string' ? err.body : (JSON.stringify(err.body) ?? '');
            throw new DecisionRequestError(message, err.status, raw.slice(0, 200) || undefined, { cause: err });
        }
        throw new DecisionBackendError(message, err.status, { cause: err });
    }
    if (err instanceof TypeSafeError) {
        throw new DecisionRequestError(message, undefined, message, { cause: err });
    }
    throw err;
}
