import { toMs } from './date';

export interface CursorData {
    id: string;
    createdAt?: number;
    offset?: number;
}

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
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(encoded: string): string {
    try {
        return Buffer.from(encoded, 'base64url').toString('utf-8');
    } catch (error) {
        throw new Error(`Invalid cursor encoding: ${String(error)}`);
    }
}

export function encodeCursorFromItem(id: string, createdAt?: Date | number, offset?: number): string {
    return encodeCursor(createCursor(id, createdAt, offset));
}

export function decodeAndParseCursor(encoded: string): CursorData {
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
