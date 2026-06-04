/** Canonical domain-error codes carried by every {@link AppError}. */
export const ErrorCode = {
    NotFound: 'NOT_FOUND',
    Validation: 'VALIDATION',
    Conflict: 'CONFLICT',
    Internal: 'INTERNAL',
} as const;

/** Union of all values in the {@link ErrorCode} const object. */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Base application error: holds a machine-readable {@link ErrorCode} `code`. */
export class AppError extends Error {
    readonly code: ErrorCode;

    constructor(code: ErrorCode, message: string) {
        super(message);
        this.name = 'AppError';
        this.code = code;
    }
}

/** Specialized {@link AppError} for "not found" scenarios. Carries `ErrorCode.NotFound`. */
export class NotFoundError extends AppError {
    constructor(message: string) {
        super(ErrorCode.NotFound, message);
        this.name = 'NotFoundError';
    }
}

/** Specialized {@link AppError} for validation failures. Carries `ErrorCode.Validation`. */
export class ValidationError extends AppError {
    constructor(message: string) {
        super(ErrorCode.Validation, message);
        this.name = 'ValidationError';
    }
}

/** Specialized {@link AppError} for resource conflicts. Carries `ErrorCode.Conflict`. */
export class ConflictError extends AppError {
    constructor(message: string) {
        super(ErrorCode.Conflict, message);
        this.name = 'ConflictError';
    }
}

/** Specialized {@link AppError} for unexpected internal failures. Carries `ErrorCode.Internal` and an optional root `cause`. */
export class InternalError extends AppError {
    constructor(
        message: string,
        override readonly cause?: unknown,
    ) {
        super(ErrorCode.Internal, message);
        this.name = 'InternalError';
    }
}

/** Type guard: narrows an unknown error value to {@link AppError}. */
export function isAppError(error: unknown): error is AppError {
    return error instanceof AppError;
}
