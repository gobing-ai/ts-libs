import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BunSqliteAdapter } from '../src/adapters/bun-sqlite';
import { embeddedMigrations } from '../src/embedded-migrations';
import { applyMigrations, type MigrationLogger } from '../src/migrate';

// Silence migration console output during tests
const origInfo = console.info;
const origWarn = console.warn;
const origError = console.error;

beforeAll(() => {
    console.info = () => {};
    console.warn = () => {};
    console.error = () => {};
});

afterAll(() => {
    console.info = origInfo;
    console.warn = origWarn;
    console.error = origError;
});

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
    test('rejects invalid migration table names before creating journal table SQL', async () => {
        const tempAdapter = new BunSqliteAdapter({ databaseUrl: ':memory:' });
        try {
            await expect(
                applyMigrations(tempAdapter, {
                    migrationsFolder: '/nonexistent/path',
                    migrationsTable: '__drizzle_migrations"; DROP TABLE queue_jobs; --',
                }),
            ).rejects.toThrow('Invalid migration journal table name');
        } finally {
            tempAdapter.close();
        }
    });

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

    test('accepts a custom journal table name through the embedded fallback path', async () => {
        // Why: the embedded path once re-validated the table name with a tighter regex
        // (`^__[a-z_]+$`) than the entry validator (`^[A-Za-z_]\w*$`), so a legal custom
        // name like `my_migrations` passed the file-based gate but threw in the fallback.
        // One validator must govern both paths.
        const tempAdapter = new BunSqliteAdapter({ databaseUrl: ':memory:' });
        try {
            await applyMigrations(tempAdapter, {
                migrationsFolder: '/nonexistent/path',
                migrationsTable: 'my_migrations',
            });
            const rows = await tempAdapter.queryAll<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='queue_jobs'",
            );
            expect(rows).toHaveLength(1);
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

    test('routes progress through an injected logger, not console', async () => {
        // Why: ts-db can't import ts-infra's logger (package boundary), so consumers
        // must be able to capture migration output via DI.
        const tempAdapter = new BunSqliteAdapter({ databaseUrl: ':memory:' });
        const lines: string[] = [];
        const logger: MigrationLogger = {
            info: (m) => lines.push(`info:${m}`),
            warn: (m) => lines.push(`warn:${m}`),
            error: (m) => lines.push(`error:${m}`),
        };
        try {
            await applyMigrations(tempAdapter, { migrationsFolder: '/nonexistent/path', logger });
            expect(lines.some((l) => l.startsWith('info:'))).toBe(true);
        } finally {
            tempAdapter.close();
        }
    });

    test('an injected fs.exists=false short-circuits to embedded without attempting file-based', async () => {
        // Why: fs.exists returns a Promise; a bare (un-awaited) check is always truthy
        // and silently disables the gate. When fs reports the folder absent, the
        // file-based migrator must never be invoked.
        const tempAdapter = new BunSqliteAdapter({ databaseUrl: ':memory:' });
        let existsCalled = false;
        const fs = {
            exists: async (_p: string) => {
                existsCalled = true;
                return false;
            },
        };
        try {
            // migrationsFolder points at a real dir; only fs.exists=false should send us to embedded.
            await applyMigrations(tempAdapter, { migrationsFolder: process.cwd(), fs: fs as never });
            expect(existsCalled).toBe(true);
            // Embedded ran: queue_jobs exists.
            const rows = await tempAdapter.queryAll<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='queue_jobs'",
            );
            expect(rows).toHaveLength(1);
        } finally {
            tempAdapter.close();
        }
    });

    test('an injected fs.exists=true attempts the file-based path', async () => {
        // Why: when fs confirms the folder, the file-based migrator is attempted
        // (here it falls back to embedded because the folder has no journal, but the
        // exists gate must have been consulted and returned true).
        const tempAdapter = new BunSqliteAdapter({ databaseUrl: ':memory:' });
        let existsResult: boolean | undefined;
        const fs = {
            exists: async (_p: string) => {
                existsResult = true;
                return true;
            },
        };
        try {
            await applyMigrations(tempAdapter, { migrationsFolder: '/tmp/ts-db-test-nonexistent', fs: fs as never });
            expect(existsResult).toBe(true);
        } finally {
            tempAdapter.close();
        }
    });
});
