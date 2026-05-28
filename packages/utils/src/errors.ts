export const ErrorCode = {
    NotFound: 'NOT_FOUND',
    Validation: 'VALIDATION',
    Conflict: 'CONFLICT',
    Internal: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
    readonly code: ErrorCode;

    constructor(code: ErrorCode, message: string) {
        super(message);
        this.name = 'AppError';
        this.code = code;
    }
}

export class NotFoundError extends AppError {
    constructor(message: string) {
        super(ErrorCode.NotFound, message);
        this.name = 'NotFoundError';
    }
}

export class ValidationError extends AppError {
    constructor(message: string) {
        super(ErrorCode.Validation, message);
        this.name = 'ValidationError';
    }
}

export class ConflictError extends AppError {
    constructor(message: string) {
        super(ErrorCode.Conflict, message);
        this.name = 'ConflictError';
    }
}

export class InternalError extends AppError {
    constructor(
        message: string,
        override readonly cause?: unknown,
    ) {
        super(ErrorCode.Internal, message);
        this.name = 'InternalError';
    }
}

export function isAppError(error: unknown): error is AppError {
    return error instanceof AppError;
}
