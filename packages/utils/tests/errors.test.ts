import { describe, expect, test } from 'bun:test';

import {
    AppError,
    ConflictError,
    ErrorCode,
    InternalError,
    isAppError,
    NotFoundError,
    ValidationError,
} from '../src/errors';

describe('ErrorCode', () => {
    test('exports stable code values locally', () => {
        expect(ErrorCode).toEqual({
            NotFound: 'NOT_FOUND',
            Validation: 'VALIDATION',
            Conflict: 'CONFLICT',
            Internal: 'INTERNAL',
        });
    });
});

describe('AppError', () => {
    test('sets code, message, name, and Error prototype', () => {
        const error = new AppError(ErrorCode.Validation, 'bad input');

        expect(error.code).toBe('VALIDATION');
        expect(error.message).toBe('bad input');
        expect(error.name).toBe('AppError');
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(AppError);
    });
});

describe('domain errors', () => {
    test('map subclasses to stable codes and names', () => {
        expect(new NotFoundError('missing')).toMatchObject({
            code: 'NOT_FOUND',
            message: 'missing',
            name: 'NotFoundError',
        });
        expect(new ValidationError('invalid')).toMatchObject({
            code: 'VALIDATION',
            message: 'invalid',
            name: 'ValidationError',
        });
        expect(new ConflictError('duplicate')).toMatchObject({
            code: 'CONFLICT',
            message: 'duplicate',
            name: 'ConflictError',
        });
    });

    test('keeps InternalError cause when supplied', () => {
        const cause = new Error('db down');
        const error = new InternalError('failed', cause);

        expect(error.code).toBe('INTERNAL');
        expect(error.name).toBe('InternalError');
        expect(error.cause).toBe(cause);
        expect(new InternalError('unexpected').cause).toBeUndefined();
    });
});

describe('isAppError', () => {
    test('detects AppError instances and rejects unrelated values', () => {
        expect(isAppError(new AppError(ErrorCode.Internal, 'x'))).toBe(true);
        expect(isAppError(new NotFoundError('x'))).toBe(true);
        expect(isAppError(new Error('x'))).toBe(false);
        expect(isAppError(null)).toBe(false);
        expect(isAppError(undefined)).toBe(false);
        expect(isAppError('error')).toBe(false);
    });
});
