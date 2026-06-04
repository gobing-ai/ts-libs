import { toMs } from './date';

/** Data embedded in a cursor-based pagination token. */
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

/** Build a {@link CursorData} record from raw fields. */
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

/** Parse a raw cursor payload (JSON string or parsed object) into validated {@link CursorData}. */
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

/** Encode {@link CursorData} into an opaque base64url cursor string. */
export function encodeCursor(cursor: CursorData): string {
    return base64UrlEncode(JSON.stringify(cursor));
}

/** Decode a base64url cursor string back to its JSON representation. */
export function decodeCursor(encoded: string): string {
    return base64UrlDecode(encoded);
}

/** One-shot: create a cursor from item fields and encode it immediately. */
export function encodeCursorFromItem(id: string, createdAt?: Date | number, offset?: number): string {
    return encodeCursor(createCursor(id, createdAt, offset));
}

/** Decode a base64url cursor string and parse it into validated {@link CursorData}. Enforces a size cap to reject hostile input. */
export function decodeAndParseCursor(encoded: string): CursorData {
    if (encoded.length > MAX_ENCODED_CURSOR_LENGTH) {
        throw new Error('Invalid cursor: exceeds maximum length');
    }
    return parseCursor(decodeCursor(encoded));
}

/** Generate pagination metadata (`nextCursor`, `hasMore`, `limit`) for a list result. Uses the last item's `id` and `createdAt` as the cursor anchor. */
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
