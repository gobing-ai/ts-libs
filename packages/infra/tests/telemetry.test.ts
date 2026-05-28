import { describe, expect, test } from 'bun:test';
import { extractSqlOperation, sanitizeSql } from '../src/telemetry/db-sanitize';

describe('sanitizeSql', () => {
    test('replaces string literals with ?', () => {
        expect(sanitizeSql("SELECT * FROM users WHERE name = 'Alice'")).toBe('SELECT * FROM users WHERE name = ?');
    });

    test('replaces double-quoted strings', () => {
        expect(sanitizeSql('SELECT * FROM users WHERE name = "Bob"')).toBe('SELECT * FROM users WHERE name = ?');
    });

    test('replaces numeric literals', () => {
        expect(sanitizeSql('SELECT * FROM users WHERE id = 42')).toBe('SELECT * FROM users WHERE id = ?');
    });

    test('preserves SQL structure and keywords', () => {
        const result = sanitizeSql("INSERT INTO queue_jobs (id, type) VALUES ('123', 'test')");
        expect(result).toContain('INSERT INTO queue_jobs');
        expect(result).toContain('VALUES');
        expect(result).not.toContain('123');
        expect(result).not.toContain('test');
    });

    test('handles parameterized placeholders', () => {
        expect(sanitizeSql('SELECT * FROM users WHERE id = ? AND name = ?')).toBe(
            'SELECT * FROM users WHERE id = ? AND name = ?',
        );
    });

    test('handles empty string', () => {
        expect(sanitizeSql('')).toBe('');
    });

    test('handles escaped quotes in literals', () => {
        expect(sanitizeSql("SELECT * FROM t WHERE name = 'O''Brien'")).toBe('SELECT * FROM t WHERE name = ?');
    });
});

describe('extractSqlOperation', () => {
    test('extracts SELECT', () => {
        expect(extractSqlOperation('SELECT * FROM users')).toBe('SELECT');
    });

    test('extracts INSERT', () => {
        expect(extractSqlOperation('INSERT INTO users VALUES (1, 2)')).toBe('INSERT');
    });

    test('extracts UPDATE', () => {
        expect(extractSqlOperation('UPDATE users SET name = ?')).toBe('UPDATE');
    });

    test('extracts DELETE', () => {
        expect(extractSqlOperation('DELETE FROM users')).toBe('DELETE');
    });

    test('extracts CREATE', () => {
        expect(extractSqlOperation('CREATE TABLE test (id INTEGER)')).toBe('CREATE');
    });

    test('returns undefined for unknown', () => {
        expect(extractSqlOperation('FOO bar')).toBeUndefined();
    });

    test('handles leading whitespace', () => {
        expect(extractSqlOperation('   SELECT 1')).toBe('SELECT');
    });
});
