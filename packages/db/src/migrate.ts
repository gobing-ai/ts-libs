import { resolve } from 'node:path';
import type { FileSystem } from '@gobing-ai/ts-runtime';

import type { DbAdapter } from './adapter.js';
import { embeddedMigrations } from './embedded-migrations.js';

/**
 * Find project root by walking up looking for bun.lock.
 * @deprecated Use `FileSystem.getProjectRoot()` instead.
 * @internal — only used for backward compatibility.
 */
export function findProjectRoot(_startDir: string): string {
    return process.cwd();
}

/**
 * Options for configuring migration behaviour (folder path, table name).
 */
export interface MigrationOptions {
    /** Path to migration SQL files. Default: `fs.resolve('drizzle')` */
    migrationsFolder?: string;
    /** Name of the migrations tracking table. Default: '__drizzle_migrations' */
    migrationsTable?: string;
    /** File system abstraction for path resolution. */
    fs?: FileSystem;
}

/**
 * Ensure the migration tracking table exists with proper SQLite types.
 *
 * drizzle-orm 0.45 generates `id SERIAL PRIMARY KEY` for the journal table,
 * but SQLite doesn't recognize SERIAL as auto-increment. Pre-create with
 * proper syntax so drizzle-orm's `CREATE TABLE IF NOT EXISTS` skips it.
 */
async function ensureJournalTable(adapter: DbAdapter, table: string): Promise<void> {
    await adapter.exec(
        `CREATE TABLE IF NOT EXISTS "${table}" (` +
            'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
            'hash text NOT NULL, ' +
            'created_at numeric' +
            ')',
    );
}

/**
 * Apply migrations from embedded SQL strings (for compiled binaries).
 *
 * Checks the journal table and applies only migrations that haven't run yet.
 * Each migration is executed with adapter.exec() for file-based or adapter.run() for journal tracking.
 */
async function applyEmbeddedMigrations(adapter: DbAdapter, journalTable: string): Promise<void> {
    // Validate journal table name — this is an internal constant, never user input.
    if (!/^__[a-z_]+$/.test(journalTable)) {
        throw new Error(`Invalid migration journal table name: ${journalTable}`);
    }
    // Get already-applied hashes
    const appliedHashes = new Set<string>();
    try {
        const rows = await adapter.queryAll<{ hash: string }>(`SELECT hash FROM "${journalTable}"`);
        for (const row of rows) {
            appliedHashes.add(row.hash);
        }
    } catch {
        // Journal table may not exist yet — will be created by ensureJournalTable
    }

    let applied = 0;
    for (const migration of embeddedMigrations) {
        if (appliedHashes.has(migration.hash)) continue;

        console.info(`Applying embedded migration: ${migration.tag}`);

        // Split on semicolons and execute each non-empty statement
        const statements = migration.sql
            .split(';')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);

        for (const stmt of statements) {
            await adapter.exec(stmt);
        }

        // Record in journal
        await adapter.run(`INSERT INTO "${journalTable}" (hash, created_at) VALUES (?, ?)`, migration.hash, Date.now());
        applied++;
    }

    if (applied > 0) {
        console.info(`Applied ${applied} embedded migration(s)`);
    }
}

/**
 * Apply pending migrations using drizzle-orm's built-in migrator.
 *
 * Tracks applied migrations in the `__drizzle_migrations` table.
 * Safe to call on every startup — already-applied migrations are skipped.
 *
 * Two migration strategies:
 * 1. **File-based** (preferred): reads SQL from a `drizzle/` folder on disk.
 * 2. **Embedded** (fallback): uses SQL bundled in the binary when no folder exists.
 *
 * Only works with BunSqliteAdapter. D1 migrations should use
 * `wrangler d1 migrations apply` instead.
 *
 * @param adapter - A DbAdapter instance (must be BunSqliteAdapter).
 * @param options - Optional migration folder and table name overrides.
 */
export async function applyMigrations(adapter: DbAdapter, options?: MigrationOptions): Promise<void> {
    const { BunSqliteAdapter } = await import('./adapters/bun-sqlite.js');
    if (!(adapter instanceof BunSqliteAdapter)) {
        console.warn('Skipping in-app migrations: only supported for bun-sqlite adapter');
        return;
    }

    const table = options?.migrationsTable ?? '__drizzle_migrations';

    await ensureJournalTable(adapter, table);

    const folder = options?.migrationsFolder ?? resolve(findProjectRoot(process.cwd()), 'drizzle');

    // File-based migrations: attempt if drizzle/ folder is accessible.
    // Use FileSystem.exists when available, otherwise try and fall back to embedded.
    const fs = options?.fs;
    const tryFileBased = fs?.exists(folder) ?? true; // optimistic when no fs

    if (tryFileBased) {
        try {
            const { migrate: drizzleMigrate } = await import('drizzle-orm/bun-sqlite/migrator');

            console.info(`Applying database migrations from ${folder}`);

            await drizzleMigrate(adapter.getDrizzleDb(), {
                migrationsFolder: folder,
                ...(options?.migrationsTable !== undefined ? { migrationsTable: options.migrationsTable } : {}),
            });
            console.info('Database migrations complete');
            return;
        } catch (error) {
            // If folder doesn't exist, fall through to embedded migrations.
            // Any other error should be thrown.
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('journal') || message.includes('ENOENT') || message.includes('meta')) {
                console.info(`File-based migrations unavailable, using embedded: ${message}`);
            } else {
                console.error(`[MIGRATE] drizzleMigrate failed: ${message}`);
                throw error;
            }
        }
    }

    // Fallback: embedded migrations (for compiled binaries)
    console.info('No drizzle/ folder found — applying embedded migrations');
    await applyEmbeddedMigrations(adapter, table);
}
