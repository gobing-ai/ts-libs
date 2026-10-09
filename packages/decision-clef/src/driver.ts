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
    validateAnswers,
    validateQuestions,
} from '@gobing-ai/ts-ai-runner';
import { APIClient, APIError, type RawHttpResponse } from '@gobing-ai/ts-infra';

/** The two hosted Workers AI Clef selectors this driver can route to. */
export type ClefModel = 'clef' | 'clef-flash';

/** Construction options for {@link createClefDriver}. Credentials are always explicit. */
export interface ClefDriverOptions {
    /** Cloudflare account ID — 32 hexadecimal characters. */
    accountId: string;
    /** Cloudflare API token — non-blank, with no whitespace or control characters. */
    apiToken: string;
    /** Default model selector; per-call `ask({ model })` wins. Defaults to `clef-flash`. */
    model?: ClefModel;
    /** Request timeout in milliseconds; a positive integer. Defaults to `30000`. */
    timeoutMs?: number;
    /** Injected fetch, forwarded to the `APIClient` (tests use this instead of a socket). */
    fetch?: typeof globalThis.fetch;
}

const ACCOUNT_ID_PATTERN = /^[0-9a-fA-F]{32}$/;
const QUESTION_ID_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
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
 * Build the hosted Clef driver: validates the configuration and constructs
 * exactly one `APIClient`. No network call and no environment read happen here.
 */
export function createClefDriver(options: ClefDriverOptions): DecisionDriver {
    if (!options || typeof options !== 'object') {
        throw new DecisionConfigError('Options must be provided', 'options');
    }
    const {
        accountId,
        apiToken,
        model: configuredModel = 'clef-flash',
        timeoutMs = 30_000,
        fetch: customFetch,
    } = options;

    if (typeof accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(accountId)) {
        throw new DecisionConfigError('Invalid accountId: must be a 32-character hexadecimal string', 'accountId');
    }

    if (typeof apiToken !== 'string' || apiToken.length === 0 || hasControlOrWhitespace(apiToken)) {
        throw new DecisionConfigError(
            'Invalid apiToken: cannot be blank or contain whitespace or control characters',
            'apiToken',
        );
    }

    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new DecisionConfigError('Invalid timeoutMs: must be a positive integer', 'timeoutMs');
    }

    if (configuredModel !== 'clef' && configuredModel !== 'clef-flash') {
        throw new DecisionConfigError('Invalid model: must be clef or clef-flash', 'model');
    }

    const client = new APIClient({
        baseUrl: 'https://api.cloudflare.com/client/v4',
        timeout: timeoutMs,
        fetch: customFetch,
    });

    return {
        name: 'clef',
        async ask({ state, questions, model }) {
            try {
                validateQuestions(questions);
            } catch {
                throw new DecisionRequestError('Invalid decision questions', undefined, undefined);
            }

            if (model !== undefined && model !== 'clef' && model !== 'clef-flash') {
                throw new DecisionRequestError(
                    'Invalid model selector: must be clef or clef-flash',
                    undefined,
                    undefined,
                );
            }
            const resolvedModel: ClefModel = model ?? configuredModel;

            const questionEntries = Object.entries(questions);
            if (questionEntries.length < 1 || questionEntries.length > 64) {
                throw new DecisionRequestError(
                    `Question count must be between 1 and 64, got ${questionEntries.length}`,
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
                    if (levels < 2 || levels > 10) {
                        throw new DecisionRequestError(
                            `Score question must have between 2 and 10 score levels, got ${levels}`,
                            undefined,
                            undefined,
                        );
                    }
                }
            }

            assertJsonSerializable(state, 'state');

            const mappedQuestions = Object.fromEntries(
                questionEntries.map(([name, q]) => [name, mapQuestion(name, q)]),
            );

            const requestBody = {
                model: resolvedModel,
                state: state ?? null,
                questions: mappedQuestions,
            };

            assertJsonSerializable(requestBody, 'request');

            const bodyString = JSON.stringify(requestBody);
            const bodyBytes = new TextEncoder().encode(bodyString).byteLength;
            if (bodyBytes > MAX_REQUEST_BODY_BYTES) {
                throw new DecisionRequestError('Request body exceeds maximum size of 13 MiB', undefined, undefined);
            }

            const path = `/accounts/${accountId}/ai/run/@cf/cloudflare/${resolvedModel}`;
            let response: RawHttpResponse;
            try {
                response = await client.rawRequest('POST', path, bodyString, {
                    headers: {
                        Authorization: `Bearer ${apiToken}`,
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

            if (!isRecord(json) || json.success !== true) {
                throw new DecisionBackendError('Backend returned failure envelope', response.status);
            }

            if (!isRecord(json.result)) {
                throw new DecisionBackendError('Missing or invalid result in response', response.status);
            }

            const result = json.result;
            if (typeof result.model !== 'string' || result.model.trim().length === 0) {
                throw new DecisionBackendError('Invalid or missing model in response', response.status);
            }

            if (!isRecord(result.answers)) {
                throw new DecisionBackendError('Invalid or missing answers in response', response.status);
            }

            const answers: Record<string, Answer> = Object.create(null);
            for (const [name, rawAnswer] of Object.entries(result.answers)) {
                if (!isRecord(rawAnswer)) {
                    throw new DecisionBackendError('Invalid answer in response', response.status);
                }
                switch (rawAnswer.type) {
                    case 'choice': {
                        if (
                            typeof rawAnswer.choice !== 'string' ||
                            typeof rawAnswer.confidence !== 'number' ||
                            !isRecord(rawAnswer.probabilities)
                        ) {
                            throw new DecisionBackendError('Malformed choice answer in response', response.status);
                        }
                        answers[name] = {
                            kind: 'choice',
                            label: rawAnswer.choice,
                            confidence: rawAnswer.confidence,
                            // Cast: shared validateAnswers re-checks every entry's bounds and mass; this
                            // only reshapes the untyped wire record into the neutral answer shape.
                            probabilities: Object.fromEntries(Object.entries(rawAnswer.probabilities)) as Record<
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
                            !isRecord(rawAnswer.legend) ||
                            !isRecord(rawAnswer.probabilities)
                        ) {
                            throw new DecisionBackendError('Malformed score answer in response', response.status);
                        }
                        answers[name] = {
                            kind: 'score',
                            score: rawAnswer.score,
                            confidence: rawAnswer.confidence,
                            legend: Object.fromEntries(Object.entries(rawAnswer.legend)) as Record<number, Desc>,
                            probabilities: Object.fromEntries(Object.entries(rawAnswer.probabilities)) as Record<
                                number,
                                number
                            >,
                        };
                        break;
                    }
                    case 'noul': {
                        if (typeof rawAnswer.noul !== 'number') {
                            throw new DecisionBackendError('Malformed noul answer in response', response.status);
                        }
                        answers[name] = {
                            kind: 'noul',
                            probability: rawAnswer.noul,
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
