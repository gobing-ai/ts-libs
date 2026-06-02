import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { getDrizzleTableName, sqlExpressionToText } from '../../src/schema/drizzle-internals';

// These tests pin the *unversioned* drizzle internals this module quarantines
// (SQL `queryChunks` + the `drizzle:Name` symbol). If a drizzle upgrade changes
// either shape, these fail loudly here — the single place that knowledge lives.

describe('sqlExpressionToText', () => {
    test('renders a sql`...` literal expression to its SQL text', () => {
        expect(sqlExpressionToText(sql`1`)).toBe('1');
        expect(sqlExpressionToText(sql`NULL`)).toBe('NULL');
    });

    test('renders a parenthesised SQL function expression', () => {
        // The kind of default that drives DDL generation, e.g. DEFAULT (unixepoch()).
        expect(sqlExpressionToText(sql`(unixepoch())`)).toContain('unixepoch');
    });

    test('returns undefined for non-SQL values so callers fall through', () => {
        expect(sqlExpressionToText(42)).toBeUndefined();
        expect(sqlExpressionToText('plain')).toBeUndefined();
        expect(sqlExpressionToText(null)).toBeUndefined();
        expect(sqlExpressionToText({})).toBeUndefined();
    });
});

describe('getDrizzleTableName', () => {
    test('resolves a drizzle table to its declared name', () => {
        const users = sqliteTable('users', { id: text('id') });
        expect(getDrizzleTableName(users)).toBe('users');
    });
});
