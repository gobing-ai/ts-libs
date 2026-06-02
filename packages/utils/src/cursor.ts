import { toMs } from './date';

export interface CursorData {
    id: string;
    createdAt?: number;
    offset?: number;
}

/**
 * Upper bound on an encoded cursor. Cursors are short by construction (id + two numbers); a longer
 * input is hostile (cursors are client-supplied pagination tokens) and is rejected before decode.
 */
const MAX_ENCODED_CURSOR_LENGTH = 1024;

export function createCursor(id: string, createdAt?: Date | number, offset?: number): CursorData {
    const cursor: CursorData = { id };
    if (createdAt !== undefined) {
        const ms = toMs(createdAt);
        if (ms !== null) {
            cursor.createdAt = ms;
        }
    }
    if (offset !== undefined) {
        cursor.offset = offset;
    }
    return cursor;
}

export function parseCursor(data: string | Record<string, unknown>): CursorData {
    const parsed = typeof data === 'string' ? (JSON.parse(data) as Record<string, unknown>) : data;

    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid cursor: must be an object');
    }

    if (!parsed.id || typeof parsed.id !== 'string') {
        throw new Error('Invalid cursor: missing or invalid id');
    }

    const result: CursorData = { id: parsed.id };
    if (typeof parsed.createdAt === 'number') {
        result.createdAt = parsed.createdAt;
    }
    if (typeof parsed.offset === 'number') {
        result.offset = parsed.offset;
    }
    return result;
}

export function encodeCursor(cursor: CursorData): string {
    return base64UrlEncode(JSON.stringify(cursor));
}

export function decodeCursor(encoded: string): string {
    return base64UrlDecode(encoded);
}

export function encodeCursorFromItem(id: string, createdAt?: Date | number, offset?: number): string {
    return encodeCursor(createCursor(id, createdAt, offset));
}

export function decodeAndParseCursor(encoded: string): CursorData {
    if (encoded.length > MAX_ENCODED_CURSOR_LENGTH) {
        throw new Error('Invalid cursor: exceeds maximum length');
    }
    return parseCursor(decodeCursor(encoded));
}

export function buildCursorMeta<T extends { id: string; createdAt?: number | Date }>(
    items: T[],
    limit: number,
    hasMore: boolean,
): { nextCursor?: string; hasMore: boolean; limit: number } {
    const meta: { nextCursor?: string; hasMore: boolean; limit: number } = {
        hasMore,
        limit,
    };

    if (hasMore) {
        const lastItem = items.at(-1);
        if (lastItem) {
            meta.nextCursor = encodeCursorFromItem(lastItem.id, lastItem.createdAt);
        }
    }

    return meta;
}

// Web-standard base64url codec via `btoa`/`atob` (available on Node, Bun, and Cloudflare Workers) —
// avoids node-only `Buffer` so cursors work in every runtime that depends on ts-utils.

function base64UrlEncode(text: string): string {
    // Encode to UTF-8 bytes first, then to a binary string `btoa` accepts (it only handles latin1).
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(encoded: string): string {
    const base64 = encoded.replaceAll('-', '+').replaceAll('_', '/');
    let binary: string;
    try {
        binary = atob(base64);
    } catch {
        throw new Error('Invalid cursor encoding: not valid base64url');
    }
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}
