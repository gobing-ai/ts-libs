import { describe, expect, test } from 'bun:test';

import {
    API_ERROR_CODES,
    badRequestResponse,
    conflictResponse,
    errorResponse,
    forbiddenResponse,
    infoResponse,
    internalErrorResponse,
    notFoundResponse,
    paginatedResponse,
    successResponse,
    unauthorizedResponse,
    validationErrorResponse,
} from '../src/api-response';

describe('success and info responses', () => {
    test('wrap typed data with success and info envelopes', () => {
        expect(successResponse({ name: 'test' })).toEqual({
            code: 0,
            message: 'Success',
            result: 'success',
            data: { name: 'test' },
        });
        expect(successResponse({ id: 1 }, 'Created').message).toBe('Created');

        expect(infoResponse([{ id: 1 }])).toEqual({
            code: 0,
            message: 'Data retrieved successfully',
            result: 'info',
            data: [{ id: 1 }],
        });
    });

    test('wraps paginated data with metadata', () => {
        expect(paginatedResponse([{ id: 1 }], { total: 100, limit: 10, offset: 0 })).toEqual({
            code: 0,
            message: 'Data retrieved successfully',
            result: 'info',
            data: [{ id: 1 }],
            meta: { total: 100, limit: 10, offset: 0 },
        });
    });
});

describe('errorResponse', () => {
    test('classifies 4xx as warn, 5xx as error, and conditionally attaches details', () => {
        expect(errorResponse(404, 'Not found')).toEqual({
            code: 404,
            message: 'Not found',
            result: 'warn',
            data: null,
        });
        expect(errorResponse(500, 'Boom').result).toBe('error');
        expect(errorResponse(400, 'Bad', { fields: ['name'] }).details).toEqual({ fields: ['name'] });
        expect(errorResponse(400, 'Bad').details).toBeUndefined();
    });
});

describe('convenience error helpers', () => {
    test('use stable API error codes and default messages', () => {
        expect(API_ERROR_CODES.SUCCESS).toBe(0);
        expect(notFoundResponse()).toMatchObject({ code: 404, result: 'warn' });
        expect(validationErrorResponse({ name: ['Required'] })).toMatchObject({
            code: 422,
            details: { name: ['Required'] },
        });
        expect(badRequestResponse('Missing field')).toMatchObject({ code: 400 });
        expect(unauthorizedResponse()).toMatchObject({ code: 401, result: 'warn' });
        expect(forbiddenResponse()).toMatchObject({ code: 403 });
        expect(conflictResponse()).toMatchObject({ code: 409 });
        expect(internalErrorResponse()).toMatchObject({ code: 500, result: 'error' });
    });

    test('accept custom messages and details', () => {
        expect(notFoundResponse('User not found', { userId: 'x' })).toMatchObject({
            message: 'User not found',
            details: { userId: 'x' },
        });
        expect(internalErrorResponse('DB down', { error: 'timeout' })).toMatchObject({
            message: 'DB down',
            details: { error: 'timeout' },
        });
    });
});
