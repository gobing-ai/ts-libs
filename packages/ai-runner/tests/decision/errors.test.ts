import { describe, expect, test } from 'bun:test';
import {
    DecisionAuthError,
    DecisionBackendError,
    DecisionConfigError,
    DecisionConnectionError,
    DecisionError,
    DecisionRateLimitError,
    DecisionRequestError,
    DecisionTimeoutError,
} from '../../src/decision/errors';

const subclasses: Array<[new (...args: never[]) => DecisionError, unknown[]]> = [
    [DecisionConfigError, ['missing key', 'TYPESAFE_API_KEY']],
    [DecisionAuthError, ['denied', 401]],
    [DecisionRateLimitError, ['slow down', 429, 2000]],
    [DecisionTimeoutError, ['timed out', 30000]],
    [DecisionConnectionError, ['unreachable', { cause: new Error('ECONNREFUSED') }]],
    [DecisionRequestError, ['malformed', 400, '{"error":"invalid"}']],
    [DecisionBackendError, ['upstream', 500]],
];

describe('decision error taxonomy', () => {
    test('every subclass is a DecisionError and an Error with its own name', () => {
        for (const [ctor, args] of subclasses) {
            const error = new ctor(...(args as never[]));
            expect(error).toBeInstanceOf(DecisionError);
            expect(error).toBeInstanceOf(Error);
            expect(error.name).toBe(ctor.name);
        }
    });

    test('DecisionConfigError carries the variable name', () => {
        const error = new DecisionConfigError('missing key', 'TYPESAFE_API_KEY');
        expect(error.variable).toBe('TYPESAFE_API_KEY');
        expect(error.message).toBe('missing key');
    });

    test('DecisionAuthError and DecisionBackendError carry status', () => {
        expect(new DecisionAuthError('denied', 401).status).toBe(401);
        expect(new DecisionAuthError('denied', undefined).status).toBeUndefined();
        expect(new DecisionBackendError('upstream', 503).status).toBe(503);
    });

    test('DecisionRateLimitError carries status and retryAfterMs', () => {
        const error = new DecisionRateLimitError('slow down', 429, 2000);
        expect(error.status).toBe(429);
        expect(error.retryAfterMs).toBe(2000);
    });

    test('DecisionTimeoutError carries timeoutMs', () => {
        expect(new DecisionTimeoutError('timed out', 30000).timeoutMs).toBe(30000);
    });

    test('DecisionConnectionError carries the underlying cause', () => {
        const cause = new Error('ECONNREFUSED');
        const error = new DecisionConnectionError('unreachable', { cause });
        expect(error.cause).toBe(cause);
    });

    test('DecisionRequestError carries status and body summary', () => {
        const error = new DecisionRequestError('malformed', 422, '{"error":"invalid labels"}');
        expect(error.status).toBe(422);
        expect(error.bodySummary).toBe('{"error":"invalid labels"}');
    });
});
