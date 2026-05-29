import { describe, expect, test } from 'bun:test';
import { embeddedMigrations } from '../src/embedded-migrations';

describe('embeddedMigrations', () => {
    test('is a non-empty array', () => {
        expect(Array.isArray(embeddedMigrations)).toBeTrue();
        expect(embeddedMigrations.length).toBeGreaterThan(0);
    });

    test('each migration has required fields', () => {
        for (const m of embeddedMigrations) {
            expect(typeof m.tag).toBe('string');
            expect(m.tag.length).toBeGreaterThan(0);
            expect(typeof m.sql).toBe('string');
            expect(m.sql.length).toBeGreaterThan(0);
            expect(typeof m.hash).toBe('string');
            expect(m.hash.length).toBe(64); // SHA-256 hex
        }
    });

    test('tags are unique', () => {
        const tags = embeddedMigrations.map((m) => m.tag);
        expect(new Set(tags).size).toBe(tags.length);
    });

    test('hashes are unique', () => {
        const hashes = embeddedMigrations.map((m) => m.hash);
        expect(new Set(hashes).size).toBe(hashes.length);
    });
});
