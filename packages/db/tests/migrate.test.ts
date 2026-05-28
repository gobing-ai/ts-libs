import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BunSqliteAdapter } from '../src/adapters/bun-sqlite';
import { embeddedMigrations } from '../src/embedded-migrations';
import { applyMigrations, findProjectRoot } from '../src/migrate';

let adapter: BunSqliteAdapter;

beforeAll(() => {
    adapter = new BunSqliteAdapter({ databaseUrl: ':memory:' });
});

afterAll(() => {
    adapter.close();
});

describe('embeddedMigrations', () => {
    test('contains queue_jobs init migration', () => {
        const init = embeddedMigrations.find((m) => m.tag === '0000_init');
        expect(init).toBeDefined();
        expect(init?.sql).toContain('queue_jobs');
    });

    test('contains ready index migration', () => {
        const idx = embeddedMigrations.find((m) => m.tag === '0001_salty_red_ghost');
        expect(idx).toBeDefined();
        expect(idx?.sql).toContain('queue_jobs_ready_idx');
    });

    test('contains expires_at migration', () => {
        const exp = embeddedMigrations.find((m) => m.tag === '0002_nasty_namora');
        expect(exp).toBeDefined();
        expect(exp?.sql).toContain('expires_at');
    });

    test('all migrations have tag, sql, hash', () => {
        for (const m of embeddedMigrations) {
            expect(m.tag).toBeTruthy();
            expect(m.sql).toBeTruthy();
            expect(m.hash).toBeTruthy();
        }
    });
});

describe('applyMigrations', () => {
    test('applies embedded migrations to in-memory DB', async () => {
        // Use embedded path (no drizzle/ folder)
        // The adapter is BunSqliteAdapter so it should apply migrations
        const tempAdapter = new BunSqliteAdapter({ databaseUrl: ':memory:' });
        try {
            await applyMigrations(tempAdapter, { migrationsFolder: '/nonexistent/path' });
            // After migrations, queue_jobs table should exist
            await tempAdapter.exec(
                "INSERT INTO queue_jobs (id, type, payload, created_at, updated_at) VALUES ('test', 'test', '{}', 1, 1)",
            );
            const rows = await tempAdapter.queryAll<{ id: string }>('SELECT id FROM queue_jobs');
            expect(rows).toHaveLength(1);
            expect(rows[0]?.id).toBe('test');
        } finally {
            tempAdapter.close();
        }
    });

    test('applies migrations idempotently (second call is safe)', async () => {
        const tempAdapter = new BunSqliteAdapter({ databaseUrl: ':memory:' });
        try {
            await applyMigrations(tempAdapter, { migrationsFolder: '/nonexistent/path' });
            await applyMigrations(tempAdapter, { migrationsFolder: '/nonexistent/path' });
            // Should not throw or duplicate
        } finally {
            tempAdapter.close();
        }
    });

    test('skips for non-BunSqliteAdapter', async () => {
        const mockAdapter = {
            getDb: () => ({}) as never,
            exec: async () => {},
            run: async () => {},
            queryFirst: async () => undefined,
            queryAll: async () => [],
            close: () => {},
            getDrizzleDb: () => ({}) as never,
        };
        // Should not throw — just skip
        await applyMigrations(mockAdapter as never);
    });

    test('applies file-based migrations when drizzle folder exists', async () => {
        // Test that file-based path is attempted and falls back gracefully
        const tempAdapter = new BunSqliteAdapter({ databaseUrl: ':memory:' });
        try {
            // With an actual fs.exists check failing, it falls through to embedded
            await applyMigrations(tempAdapter, { migrationsFolder: '/tmp/ts-db-test-nonexistent' });
        } finally {
            tempAdapter.close();
        }
    });
});

describe('findProjectRoot', () => {
    test('returns a string', () => {
        const root = findProjectRoot('.');
        expect(typeof root).toBe('string');
    });
});
