import {
    type Answer,
    DecisionAuthError,
    DecisionBackendError,
    DecisionConfigError,
    DecisionConnectionError,
    type DecisionDriver,
    DecisionRateLimitError,
    DecisionRequestError,
    DecisionTimeoutError,
    type Desc,
    type Question,
    type ScoreQuestion,
    validateAnswers,
    validateQuestions,
} from '@gobing-ai/ts-ai-runner';
import { APIClient, APIError, type RawHttpResponse } from '@gobing-ai/ts-infra';

/** The hosted Gemini decision selector this driver routes to. */
export type GeminiDecisionModel = 'gemini-decision-1';

/** Construction options for {@link createGeminiDecisionDriver}. Credentials are always explicit. */
export interface GeminiDecisionDriverOptions {
    /** Google API key — non-blank, with no whitespace or control characters. */
    apiKey: string;
    /** Default model selector; per-call `ask({ model })` wins. Defaults to `gemini-decision-1`. */
    model?: GeminiDecisionModel;
    /** API origin, `http:`/`https:` only, no credentials/query/hash. Defaults to the Google endpoint. */
    baseURL?: string;
    /** Request timeout in milliseconds; a positive integer. Defaults to `30000`. */
    timeoutMs?: number;
    /** Injected fetch, forwarded to the `APIClient` (tests use this instead of a socket). */
    fetch?: typeof globalThis.fetch;
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const QUESTION_ID_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const MAX_QUESTIONS = 1000;
const MAX_REQUEST_BODY_BYTES = 13 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Blank, whitespace and C0/DEL control characters cannot survive an HTTP header round-trip. */
function hasControlOrWhitespace(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code <= 0x20 || code === 0x7f) return true;
    }
    return false;
}

function assertJsonSerializable(value: unknown, context: string, ancestors = new Set<unknown>()): void {
    if (value === null) return;
    if (typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new DecisionRequestError(`Non-finite number in ${context}`, undefined, undefined);
        }
        return;
    }
    if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol' || value === undefined) {
        throw new DecisionRequestError(`Unserializable ${typeof value} in ${context}`, undefined, undefined);
    }
    if (typeof value === 'object') {
        if (ancestors.has(value)) {
            throw new DecisionRequestError(`Circular reference detected in ${context}`, undefined, undefined);
        }
        ancestors.add(value);
        try {
            if (
                Object.values(Object.getOwnPropertyDescriptors(value)).some(
                    (property) => !Object.hasOwn(property, 'value'),
                )
            ) {
                throw new DecisionRequestError(`Accessor property in ${context}`, undefined, undefined);
            }
            if (Array.isArray(value)) {
                // Extra own properties and holes are both dropped or coerced by JSON.stringify;
                // only a dense, index-only array survives round-trip intact.
                if (
                    Object.keys(value).length !== value.length ||
                    Object.getOwnPropertyNames(value).length !== value.length + 1 ||
                    Object.getOwnPropertySymbols(value).length > 0
                ) {
                    throw new DecisionRequestError(`Sparse or decorated array in ${context}`, undefined, undefined);
                }
                for (let i = 0; i < value.length; i++) {
                    assertJsonSerializable(value[i], context, ancestors);
                }
            } else {
                const proto = Object.getPrototypeOf(value);
                if (proto !== null && proto !== Object.prototype) {
                    throw new DecisionRequestError(`Unsupported object instance in ${context}`, undefined, undefined);
                }
                // Symbol keys and non-enumerable own properties are invisible to Object.keys and are
                // dropped by JSON.stringify, so they would otherwise be a silent loss.
                const ownNames = Object.getOwnPropertyNames(value);
                if (Object.getOwnPropertySymbols(value).length > 0 || ownNames.length !== Object.keys(value).length) {
                    throw new DecisionRequestError(`Unserializable own property in ${context}`, undefined, undefined);
                }
                for (const key of ownNames) {
                    assertJsonSerializable((value as Record<string, unknown>)[key], context, ancestors);
                }
            }
        } finally {
            ancestors.delete(value);
        }
        return;
    }
    throw new DecisionRequestError(`Unserializable value in ${context}`, undefined, undefined);
}

function resolveInstructions(prompt: Desc | undefined, questionId: string): unknown {
    if (prompt === undefined || prompt === null) {
        return questionId;
    }
    if (typeof prompt === 'string' && prompt.trim().length === 0) {
        return questionId;
    }
    return prompt;
}

function mapQuestion(name: string, q: Question): Record<string, unknown> {
    const instructions = resolveInstructions(q.prompt, name);
    switch (q.kind) {
        case 'choice':
            return {
                type: 'choice',
                instructions,
                criteria: Object.fromEntries(Object.entries(q.labels)),
            };
        case 'score':
            return {
                type: 'score',
                instructions,
                criteria: q.rubric,
            };
        case 'noul': {
            const mapped: Record<string, unknown> = {
                type: 'noul',
                instructions,
            };
            if (q.yes !== undefined || q.no !== undefined) {
                const criteria: Record<string, unknown> = {};
                if (q.yes !== undefined) criteria.true = q.yes;
                if (q.no !== undefined) criteria.false = q.no;
                mapped.criteria = criteria;
            }
            return mapped;
        }
    }
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === target) {
            return value;
        }
    }
    return undefined;
}

function parseRetryAfter(header: string | undefined): number | undefined {
    if (!header) return undefined;
    const trimmed = header.trim();
    if (/^\d+$/.test(trimmed)) {
        const milliseconds = Number(trimmed) * 1000;
        return Number.isFinite(milliseconds) ? milliseconds : undefined;
    }
    // HTTP dates start with a weekday; Date.parse also accepts invalid numeric hints as dates.
    if (!/^[A-Za-z]+(?:,| )/.test(trimmed)) return undefined;
    const timestamp = Date.parse(trimmed);
    if (!Number.isNaN(timestamp)) {
        return Math.max(0, timestamp - Date.now());
    }
    return undefined;
}

/**
 * Normalize a wire probability distribution into a string-keyed record. The Decisions API
 * accepts both a keyed object (`{ "0": 0.9 }` / `{ bug: 0.9 }`) and an array of
 * `{ value, probability }` entries; `validateAnswers` needs the record form.
 */
function normalizeDistribution(raw: unknown, status: number): Record<string, number> {
    if (isRecord(raw)) {
        return Object.fromEntries(Object.entries(raw)) as Record<string, number>;
    }
    if (Array.isArray(raw)) {
        const out: Record<string, number> = {};
        for (const entry of raw) {
            if (!isRecord(entry) || !('value' in entry) || typeof entry.probability !== 'number') {
                throw new DecisionBackendError('Malformed probability distribution in response', status);
            }
            out[String(entry.value)] = entry.probability;
        }
        return out;
    }
    throw new DecisionBackendError('Malformed probability distribution in response', status);
}

/**
 * Build the hosted Gemini decision driver: validates the configuration and constructs
 * exactly one `APIClient`. No network call and no environment read happen here.
 */
export function createGeminiDecisionDriver(options: GeminiDecisionDriverOptions): DecisionDriver {
    if (!options || typeof options !== 'object') {
        throw new DecisionConfigError('Options must be provided', 'options');
    }
    const {
        apiKey,
        model: configuredModel = 'gemini-decision-1',
        baseURL,
        timeoutMs = 30_000,
        fetch: customFetch,
    } = options;

    if (typeof apiKey !== 'string' || apiKey.length === 0 || hasControlOrWhitespace(apiKey)) {
        throw new DecisionConfigError(
            'Invalid apiKey: cannot be blank or contain whitespace or control characters',
            'apiKey',
        );
    }

    let baseUrl = DEFAULT_BASE_URL;
    if (baseURL !== undefined) {
        let parsed: URL;
        try {
            parsed = new URL(baseURL);
        } catch {
            throw new DecisionConfigError('Invalid baseURL: must be a valid http(s) URL', 'baseURL');
        }
        if (
            (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
            parsed.username.length > 0 ||
            parsed.password.length > 0 ||
            parsed.search.length > 0 ||
            parsed.hash.length > 0
        ) {
            throw new DecisionConfigError(
                'Invalid baseURL: must be an http(s) URL without credentials, query or hash',
                'baseURL',
            );
        }
        baseUrl = baseURL.replace(/\/+$/, '');
    }

    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new DecisionConfigError('Invalid timeoutMs: must be a positive integer', 'timeoutMs');
    }

    if (configuredModel !== 'gemini-decision-1') {
        throw new DecisionConfigError('Invalid model: must be gemini-decision-1', 'model');
    }

    const client = new APIClient({
        baseUrl,
        timeout: timeoutMs,
        fetch: customFetch,
    });

    return {
        name: 'gemini-decision',
        async ask({ state, questions, model }) {
            try {
                validateQuestions(questions);
            } catch {
                throw new DecisionRequestError('Invalid decision questions', undefined, undefined);
            }

            if (model !== undefined && model !== 'gemini-decision-1') {
                throw new DecisionRequestError(
                    'Invalid model selector: must be gemini-decision-1',
                    undefined,
                    undefined,
                );
            }
            const resolvedModel: GeminiDecisionModel = model ?? configuredModel;

            const questionEntries = Object.entries(questions);
            if (questionEntries.length < 1 || questionEntries.length > MAX_QUESTIONS) {
                throw new DecisionRequestError(
                    `Question count must be between 1 and ${MAX_QUESTIONS}, got ${questionEntries.length}`,
                    undefined,
                    undefined,
                );
            }

            for (const [name, q] of questionEntries) {
                if (!QUESTION_ID_PATTERN.test(name)) {
                    throw new DecisionRequestError(
                        'Question ID does not match pattern ^[A-Za-z0-9_.-]{1,100}$',
                        undefined,
                        undefined,
                    );
                }
                if (q.kind === 'choice') {
                    const labelKeys = Object.keys(q.labels);
                    if (labelKeys.length < 2 || labelKeys.length > 255) {
                        throw new DecisionRequestError(
                            `Choice question must have between 2 and 255 choice IDs, got ${labelKeys.length}`,
                            undefined,
                            undefined,
                        );
                    }
                    for (const labelId of labelKeys) {
                        if (labelId.length === 0) {
                            throw new DecisionRequestError(
                                'Choice question contains empty choice ID',
                                undefined,
                                undefined,
                            );
                        }
                    }
                } else if (q.kind === 'score') {
                    const levels = q.rubric.length;
                    if (levels < 2 || levels > 255) {
                        throw new DecisionRequestError(
                            `Score question must have between 2 and 255 score levels, got ${levels}`,
                            undefined,
                            undefined,
                        );
                    }
                }
            }

            // `undefined` means "no caller context" exactly as `null` does — the neutral contract
            // has one absent state, so validate it as such rather than rejecting it as unserializable.
            assertJsonSerializable(state ?? null, 'state');

            const mappedQuestions = Object.fromEntries(
                questionEntries.map(([name, q]) => [name, mapQuestion(name, q)]),
            );

            const requestBody = {
                model: resolvedModel,
                // The Decisions API requires `input` to be present: the neutral contract's absent
                // state maps to the empty string, exactly like the clef, laya and fm drivers.
                input: state ?? '',
                questions: mappedQuestions,
            };

            assertJsonSerializable(requestBody, 'request');

            const bodyString = JSON.stringify(requestBody);
            const bodyBytes = new TextEncoder().encode(bodyString).byteLength;
            if (bodyBytes > MAX_REQUEST_BODY_BYTES) {
                throw new DecisionRequestError('Request body exceeds maximum size of 13 MiB', undefined, undefined);
            }

            let response: RawHttpResponse;
            try {
                response = await client.rawRequest('POST', '/v1beta/decisions', bodyString, {
                    headers: {
                        'x-goog-api-key': apiKey,
                        'Content-Type': 'application/json',
                    },
                    redirect: 'manual',
                    maxResponseBytes: MAX_RESPONSE_BYTES,
                });
            } catch (error) {
                // The design forbids leaking untrusted transport error text/cause through public
                // errors, so these stay generic: only the message and the timeoutMs field travel.
                if (error instanceof APIError && error.status === 0) {
                    throw new DecisionTimeoutError('Request timed out', timeoutMs);
                }
                throw new DecisionConnectionError('Failed to connect to backend');
            }

            if (response.truncated) {
                throw new DecisionBackendError('Response exceeded maximum allowed size of 8 MiB', response.status);
            }

            if (response.status >= 300 && response.status < 400) {
                throw new DecisionBackendError(`HTTP ${response.status} redirect received`, response.status);
            }

            if (response.status === 401 || response.status === 403) {
                throw new DecisionAuthError(`HTTP ${response.status} authentication failure`, response.status);
            }

            if (response.status === 429) {
                const retryAfterHeader = getHeader(response.headers, 'retry-after');
                const retryAfterMs = parseRetryAfter(retryAfterHeader);
                throw new DecisionRateLimitError('HTTP 429 rate limit exceeded', response.status, retryAfterMs);
            }

            if (response.status >= 400 && response.status < 500) {
                throw new DecisionRequestError(`HTTP ${response.status} request error`, response.status, undefined);
            }

            if (response.status >= 500 && response.status < 600) {
                throw new DecisionBackendError(`HTTP ${response.status} backend error`, response.status);
            }

            if (response.status < 200 || response.status >= 300) {
                throw new DecisionBackendError(`HTTP ${response.status} unexpected status`, response.status);
            }

            let json: unknown;
            try {
                json = JSON.parse(response.body);
            } catch {
                throw new DecisionBackendError('Malformed JSON response from backend', response.status);
            }

            if (!isRecord(json)) {
                throw new DecisionBackendError('Malformed response envelope from backend', response.status);
            }

            // The Decisions API answers either at the top level (`{ answers }`) or wrapped
            // (`{ result: { answers } }`); `answers` itself is a keyed object or an array of
            // named entries. Unknown envelopes fail closed.
            let rawAnswers: unknown;
            if (json.answers !== undefined) {
                rawAnswers = json.answers;
            } else if (isRecord(json.result) && json.result.answers !== undefined) {
                rawAnswers = json.result.answers;
            } else {
                throw new DecisionBackendError('Invalid or missing answers in response', response.status);
            }

            let rawEntries: [string, unknown][];
            if (Array.isArray(rawAnswers)) {
                rawEntries = rawAnswers.map((entry) => {
                    if (!isRecord(entry) || typeof entry.name !== 'string') {
                        throw new DecisionBackendError('Invalid answer entry in response', response.status);
                    }
                    return [entry.name, entry] as [string, unknown];
                });
            } else if (isRecord(rawAnswers)) {
                rawEntries = Object.entries(rawAnswers);
            } else {
                throw new DecisionBackendError('Invalid or missing answers in response', response.status);
            }

            const answers: Record<string, Answer> = Object.create(null);
            for (const [name, rawAnswer] of rawEntries) {
                if (!isRecord(rawAnswer)) {
                    throw new DecisionBackendError('Invalid answer in response', response.status);
                }
                switch (rawAnswer.type) {
                    case 'choice': {
                        const label = rawAnswer.choice ?? rawAnswer.label;
                        if (
                            typeof label !== 'string' ||
                            typeof rawAnswer.confidence !== 'number' ||
                            rawAnswer.probabilities === undefined
                        ) {
                            throw new DecisionBackendError('Malformed choice answer in response', response.status);
                        }
                        answers[name] = {
                            kind: 'choice',
                            label,
                            confidence: rawAnswer.confidence,
                            // Cast: shared validateAnswers re-checks every entry's bounds and mass; this
                            // only reshapes the untyped wire record into the neutral answer shape.
                            probabilities: normalizeDistribution(rawAnswer.probabilities, response.status) as Record<
                                string,
                                number
                            >,
                        };
                        break;
                    }
                    case 'score': {
                        if (
                            typeof rawAnswer.score !== 'number' ||
                            typeof rawAnswer.confidence !== 'number' ||
                            rawAnswer.probabilities === undefined
                        ) {
                            throw new DecisionBackendError('Malformed score answer in response', response.status);
                        }
                        const rubric =
                            questions[name]?.kind === 'score' ? (questions[name] as ScoreQuestion).rubric : undefined;
                        const legend =
                            rawAnswer.legend !== undefined
                                ? (normalizeDistribution(rawAnswer.legend, response.status) as unknown)
                                : // Legend omitted on wire: fall back to the request's rubric, indexed
                                  // 0-based to match the neutral ScoreAnswer key contract.
                                  Object.fromEntries((rubric ?? []).map((desc, index) => [String(index), desc]));
                        if (!isRecord(legend)) {
                            throw new DecisionBackendError('Malformed score legend in response', response.status);
                        }
                        answers[name] = {
                            kind: 'score',
                            score: rawAnswer.score,
                            confidence: rawAnswer.confidence,
                            legend: Object.fromEntries(Object.entries(legend)) as Record<number, Desc>,
                            probabilities: normalizeDistribution(rawAnswer.probabilities, response.status) as Record<
                                number,
                                number
                            >,
                        };
                        break;
                    }
                    case 'noul': {
                        // Only the bare probability travels; a wire `confidence` is ignored — the
                        // neutral contract refuses to fabricate calibration data.
                        const probability = rawAnswer.noul ?? rawAnswer.probability;
                        if (typeof probability !== 'number') {
                            throw new DecisionBackendError('Malformed noul answer in response', response.status);
                        }
                        answers[name] = {
                            kind: 'noul',
                            probability,
                        };
                        break;
                    }
                    default:
                        throw new DecisionBackendError('Unknown answer type in response', response.status);
                }
            }

            try {
                validateAnswers(questions, answers);
            } catch {
                throw new DecisionBackendError('Invalid decision answers in response', response.status);
            }
            return answers;
        },
    };
}
