import { describe, expect, test } from 'bun:test';

import {
    buildCursorMeta,
    createCursor,
    decodeAndParseCursor,
    decodeCursor,
    encodeCursor,
    encodeCursorFromItem,
    parseCursor,
} from '../src/cursor';

describe('createCursor', () => {
    test('creates a cursor from id, date, and offset', () => {
        const date = new Date('2024-06-15T12:00:00Z');

        expect(createCursor('item-1')).toEqual({ id: 'item-1' });
        expect(createCursor('item-1', date)).toEqual({ id: 'item-1', createdAt: date.getTime() });
        expect(createCursor('item-1', 1_718_452_800_000, 50)).toEqual({
            id: 'item-1',
            createdAt: 1_718_452_800_000,
            offset: 50,
        });
    });
});

describe('parseCursor', () => {
    test('parses valid cursor objects and JSON strings', () => {
        expect(parseCursor({ id: 'abc', createdAt: 1000, offset: 10 })).toEqual({
            id: 'abc',
            createdAt: 1000,
            offset: 10,
        });
        expect(parseCursor(JSON.stringify({ id: 'abc', createdAt: 1000 }))).toEqual({
            id: 'abc',
            createdAt: 1000,
        });
    });

    test('rejects malformed cursors', () => {
        expect(() => parseCursor(null as unknown as Record<string, unknown>)).toThrow(
            'Invalid cursor: must be an object',
        );
        expect(() => parseCursor('42')).toThrow('Invalid cursor: must be an object');
        expect(() => parseCursor({ createdAt: 1000 })).toThrow('Invalid cursor: missing or invalid id');
        expect(() => parseCursor({ id: 123 })).toThrow('Invalid cursor: missing or invalid id');
    });

    test('ignores optional fields with the wrong type', () => {
        expect(parseCursor({ id: 'abc', createdAt: 'bad', offset: 'bad' })).toEqual({ id: 'abc' });
    });
});

describe('cursor encoding', () => {
    test('round-trips URL-safe base64url cursors', () => {
        const cursor = { id: 'user-42', createdAt: 1_718_452_800_000, offset: 100 };
        const encoded = encodeCursor(cursor);

        expect(encoded).not.toContain('+');
        expect(encoded).not.toContain('/');
        expect(encoded).not.toContain('=');
        expect(JSON.parse(decodeCursor(encoded))).toEqual(cursor);
        expect(decodeAndParseCursor(encoded)).toEqual(cursor);
    });

    test('encodes from item fields', () => {
        const date = new Date('2024-01-01T00:00:00Z');

        expect(decodeAndParseCursor(encodeCursorFromItem('item-x', date, 5))).toEqual({
            id: 'item-x',
            createdAt: date.getTime(),
            offset: 5,
        });
    });

    test('throws when decoded payload is not a valid cursor', () => {
        expect(() => decodeAndParseCursor('garbage')).toThrow();
    });
});

describe('buildCursorMeta', () => {
    test('builds next cursor from the last item only when more data exists', () => {
        const meta = buildCursorMeta(
            [
                { id: 'a', createdAt: 1000 },
                { id: 'b', createdAt: 2000 },
            ],
            2,
            true,
        );

        expect(meta.hasMore).toBe(true);
        expect(meta.limit).toBe(2);
        expect(meta.nextCursor).toBeString();
        expect(decodeAndParseCursor(meta.nextCursor ?? '')).toEqual({ id: 'b', createdAt: 2000 });

        expect(buildCursorMeta([{ id: 'a', createdAt: 1000 }], 10, false)).toEqual({ hasMore: false, limit: 10 });
        expect(buildCursorMeta([], 10, true)).toEqual({ hasMore: true, limit: 10 });
    });

    test('supports Date createdAt fields', () => {
        const date = new Date('2024-06-15T12:00:00Z');
        const meta = buildCursorMeta([{ id: 'a', createdAt: date }], 1, true);

        expect(decodeAndParseCursor(meta.nextCursor ?? '').createdAt).toBe(date.getTime());
    });
});
