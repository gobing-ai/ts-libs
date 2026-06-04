import { type AppError, ErrorCode, isAppError } from './errors';

/** Standard HTTP/application error codes used in structured API responses. */
export const API_ERROR_CODES = {
    SUCCESS: 0,
    NOT_FOUND: 404,
    VALIDATION_ERROR: 422,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    CONFLICT: 409,
    INTERNAL_ERROR: 500,
} as const;

/** Union of all values in {@link API_ERROR_CODES}. */
export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

/** Sentiment tag carried in every API envelope. */
export type ApiEnvelopeResult = 'success' | 'info' | 'warn' | 'error';

/** Envelope wrapping successful API responses. */
export interface ApiSuccessEnvelope<T> {
    code: 0;
    message: string;
    result: 'success' | 'info';
    data: T;
    meta?: { total?: number; limit?: number; offset?: number };
}

/** Envelope wrapping failed or problematic API responses. */
export interface ApiErrorEnvelope {
    result: 'warn' | 'error';
    code: number;
    message: string;
    data: null;
    details?: unknown;
}

/** Generic API response: either a success envelope or an error envelope. */
export type ApiEnvelope<T> = ApiSuccessEnvelope<T> | ApiErrorEnvelope;

/** Build a generic 200-success API envelope. */
export function successResponse<T>(data: T, message = 'Success'): ApiSuccessEnvelope<T> {
    return {
        code: API_ERROR_CODES.SUCCESS,
        message,
        result: 'success',
        data,
    };
}

/** Build a 200-success API envelope tagged as informational (`result: "info"`). */
export function infoResponse<T>(data: T, message = 'Data retrieved successfully'): ApiSuccessEnvelope<T> {
    return {
        code: API_ERROR_CODES.SUCCESS,
        message,
        result: 'info',
        data,
    };
}

/** Build a 200-success envelope for paginated list endpoints, tagging as `info` and attaching pagination `meta`. */
export function paginatedResponse<T>(
    data: T[],
    meta: { total?: number; limit?: number; offset?: number },
    message = 'Data retrieved successfully',
): ApiSuccessEnvelope<T[]> {
    return {
        code: API_ERROR_CODES.SUCCESS,
        message,
        result: 'info',
        data,
        meta,
    };
}

/**
 * Build a structured API error envelope.
 *
 * Code ≥ 500 tags `result: "error"`; anything else tags `result: "warn"`.
 */
export function errorResponse(code: number, message: string, details?: unknown): ApiErrorEnvelope {
    const response: ApiErrorEnvelope = {
        code,
        message,
        result: code >= 500 ? 'error' : 'warn',
        data: null,
    };

    if (details !== undefined) {
        response.details = details;
    }

    return response;
}

/** Convenience wrapper for a 404 "not found" API error. */
export function notFoundResponse(message = 'Resource not found', details?: unknown): ApiErrorEnvelope {
    return errorResponse(API_ERROR_CODES.NOT_FOUND, message, details);
}

/** Convenience wrapper for a 422 "validation error" API error. */
export function validationErrorResponse(details: unknown, message = 'Validation failed'): ApiErrorEnvelope {
    return errorResponse(API_ERROR_CODES.VALIDATION_ERROR, message, details);
}

/** Convenience wrapper for a 400 "bad request" API error. */
export function badRequestResponse(message: string, details?: unknown): ApiErrorEnvelope {
    return errorResponse(API_ERROR_CODES.BAD_REQUEST, message, details);
}

/** Convenience wrapper for a 401 "unauthorized" API error. */
export function unauthorizedResponse(message = 'Authentication required', details?: unknown): ApiErrorEnvelope {
    return errorResponse(API_ERROR_CODES.UNAUTHORIZED, message, details);
}

/** Convenience wrapper for a 403 "forbidden" API error. */
export function forbiddenResponse(message = 'Access forbidden', details?: unknown): ApiErrorEnvelope {
    return errorResponse(API_ERROR_CODES.FORBIDDEN, message, details);
}

/** Convenience wrapper for a 409 "conflict" API error. */
export function conflictResponse(message = 'Resource conflict', details?: unknown): ApiErrorEnvelope {
    return errorResponse(API_ERROR_CODES.CONFLICT, message, details);
}

/** Convenience wrapper for a 500 "internal server error" API error. */
export function internalErrorResponse(message = 'Internal server error', details?: unknown): ApiErrorEnvelope {
    return errorResponse(API_ERROR_CODES.INTERNAL_ERROR, message, details);
}

/** Maps each domain {@link ErrorCode} to its HTTP-layer {@link ApiErrorCode}. */
const ERROR_CODE_TO_HTTP: Record<ErrorCode, ApiErrorCode> = {
    [ErrorCode.NotFound]: API_ERROR_CODES.NOT_FOUND,
    [ErrorCode.Validation]: API_ERROR_CODES.VALIDATION_ERROR,
    [ErrorCode.Conflict]: API_ERROR_CODES.CONFLICT,
    [ErrorCode.Internal]: API_ERROR_CODES.INTERNAL_ERROR,
};

// Client-actionable errors whose message is safe to surface. Internal/unknown errors are opaque:
// their message (and any `cause`) must never reach the client, to avoid leaking implementation detail.
const CLIENT_SAFE_CODES = new Set<ErrorCode>([ErrorCode.NotFound, ErrorCode.Validation, ErrorCode.Conflict]);

/**
 * Bridge a thrown error to an API error envelope — the single mapping from the domain error layer
 * ({@link AppError}) to the wire layer ({@link ApiErrorEnvelope}). Use this in request handlers
 * instead of hand-mapping `catch` blocks, so HTTP codes stay consistent across endpoints.
 *
 * A known {@link AppError} maps to its HTTP code; client-safe codes surface their message, while
 * `Internal` and any non-`AppError` collapse to an opaque 500 that leaks neither message nor stack.
 * Pass `details` only when you intend it to reach the client (e.g. validation field errors).
 */
export function toApiResponse(error: unknown, details?: unknown): ApiErrorEnvelope {
    if (isAppError(error)) {
        const httpCode = ERROR_CODE_TO_HTTP[error.code];
        const message = CLIENT_SAFE_CODES.has(error.code) ? error.message : 'Internal server error';
        return errorResponse(httpCode, message, CLIENT_SAFE_CODES.has(error.code) ? details : undefined);
    }
    return internalErrorResponse();
}
