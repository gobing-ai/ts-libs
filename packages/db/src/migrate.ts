import type { FileSystem } from '@gobing-ai/ts-runtime';
import { getProcessCwd, resolvePath } from '@gobing-ai/ts-runtime';

import type { DbAdapter } from './adapter';
import { embeddedMigrations } from './embedded-migrations';

/**
 * Minimal structural logger for migration progress.
 *
 * Structurally compatible with `@gobing-ai/ts-infra`'s `Logger` so consumers can
 * pass theirs directly — ts-db never imports ts-infra (keeps the package
 * boundary). Defaults to `console` when absent.
 */
export interface MigrationLogger {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
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
    /** Logger for migration progress. Default: `console`. */
    logger?: MigrationLogger;
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

function validateMigrationTableName(table: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
        throw new Error(`Invalid migration journal table name: ${table}`);
    }
    return table;
}

/**
 * Apply migrations from embedded SQL strings (for compiled binaries).
 *
 * Checks the journal table and applies only migrations that haven't run yet.
 * Each migration is executed with adapter.exec() for file-based or adapter.run() for journal tracking.
 */
async function applyEmbeddedMigrations(
    adapter: DbAdapter,
    journalTable: string,
    logger: MigrationLogger,
): Promise<void> {
    // The caller (`applyMigrations`) already ran the journal name through
    // `validateMigrationTableName`; re-validate with the same rule so a custom but
    // legal name (e.g. `my_migrations`) isn't rejected here while the file-based path
    // accepted it — one validator, no divergence between the two migration paths.
    validateMigrationTableName(journalTable);
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

        logger.info(`Applying embedded migration: ${migration.tag}`);

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
        logger.info(`Applied ${applied} embedded migration(s)`);
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
    const logger = options?.logger ?? console;
    const { BunSqliteAdapter } = await import('./adapters/bun-sqlite');
    if (!(adapter instanceof BunSqliteAdapter)) {
        logger.warn('Skipping in-app migrations: only supported for bun-sqlite adapter');
        return;
    }

    const table = validateMigrationTableName(options?.migrationsTable ?? '__drizzle_migrations');

    await ensureJournalTable(adapter, table);

    const folder = options?.migrationsFolder ?? resolvePath(getProcessCwd(), 'drizzle');

    // File-based migrations: attempt only if the drizzle/ folder is present.
    // With an injected fs we get a definitive answer (await the Promise — a bare
    // `fs.exists(...)` is always truthy and silently disables the check); without
    // one we attempt optimistically and fall back on the migrator's own error.
    const fs = options?.fs;
    const tryFileBased = fs ? await fs.exists(folder) : true;

    if (tryFileBased) {
        try {
            const { migrate: drizzleMigrate } = await import('drizzle-orm/bun-sqlite/migrator');

            logger.info(`Applying database migrations from ${folder}`);

            await drizzleMigrate(adapter.getDrizzleDb(), {
                migrationsFolder: folder,
                // Pass the validated `table`, not the raw option — keep one validated
                // name flowing to both the file-based migrator and the embedded fallback.
                ...(options?.migrationsTable !== undefined ? { migrationsTable: table } : {}),
            });
            logger.info('Database migrations complete');
            return;
        } catch (error) {
            // A missing/empty migrations folder is expected in compiled binaries —
            // fall through to embedded. Any other failure is real; rethrow it.
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('journal') || message.includes('ENOENT') || message.includes('meta')) {
                logger.info(`File-based migrations unavailable, using embedded: ${message}`);
            } else {
                logger.error(`[MIGRATE] drizzleMigrate failed: ${message}`);
                throw error;
            }
        }
    }

    // Fallback: embedded migrations (for compiled binaries)
    logger.info('No drizzle/ folder found — applying embedded migrations');
    await applyEmbeddedMigrations(adapter, table, logger);
}
