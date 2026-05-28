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

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

export type ApiEnvelopeResult = 'success' | 'info' | 'warn' | 'error';

export interface ApiSuccessEnvelope<T> {
    code: 0;
    message: string;
    result: 'success' | 'info';
    data: T;
    meta?: { total?: number; limit?: number; offset?: number };
}

export interface ApiErrorEnvelope {
    result: 'warn' | 'error';
    code: number;
    message: string;
    data: null;
    details?: unknown;
}

export type ApiEnvelope<T> = ApiSuccessEnvelope<T> | ApiErrorEnvelope;

export function successResponse<T>(data: T, message = 'Success'): ApiSuccessEnvelope<T> {
    return {
        code: API_ERROR_CODES.SUCCESS,
        message,
        result: 'success',
        data,
    };
}

export function infoResponse<T>(data: T, message = 'Data retrieved successfully'): ApiSuccessEnvelope<T> {
    return {
        code: API_ERROR_CODES.SUCCESS,
        message,
        result: 'info',
        data,
    };
}

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

export function notFoundResponse(message = 'Resource not found', details?: unknown): ApiErrorEnvelope {
    return errorResponse(API_ERROR_CODES.NOT_FOUND, message, details);
}

export function validationErrorResponse(details: unknown, message = 'Validation failed'): ApiErrorEnvelope {
    return errorResponse(API_ERROR_CODES.VALIDATION_ERROR, message, details);
}

export function badRequestResponse(message: string, details?: unknown): ApiErrorEnvelope {
    return errorResponse(API_ERROR_CODES.BAD_REQUEST, message, details);
}

export function unauthorizedResponse(message = 'Authentication required', details?: unknown): ApiErrorEnvelope {
    return errorResponse(API_ERROR_CODES.UNAUTHORIZED, message, details);
}

export function forbiddenResponse(message = 'Access forbidden', details?: unknown): ApiErrorEnvelope {
    return errorResponse(API_ERROR_CODES.FORBIDDEN, message, details);
}

export function conflictResponse(message = 'Resource conflict', details?: unknown): ApiErrorEnvelope {
    return errorResponse(API_ERROR_CODES.CONFLICT, message, details);
}

export function internalErrorResponse(message = 'Internal server error', details?: unknown): ApiErrorEnvelope {
    return errorResponse(API_ERROR_CODES.INTERNAL_ERROR, message, details);
}
