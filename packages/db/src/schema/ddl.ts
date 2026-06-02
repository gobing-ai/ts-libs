import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { getDrizzleTableName, sqlExpressionToText } from './drizzle-internals';

/**
 * Quote an identifier for use in SQL (double-quoted for SQLite compatibility).
 */
function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Map a column default value to its SQL literal representation.
 *
 * drizzle-orm defaults can be:
 * - primitives: number, string, boolean, null
 * - SQL expressions (sql\`...\` template results)
 * - undefined (no default, or runtime-only $defaultFn)
 */
function defaultToSql(value: unknown): string | undefined {
    if (value == null) {
        return value === null ? 'NULL' : undefined;
    }
    if (typeof value === 'number') {
        return String(value);
    }
    if (typeof value === 'string') {
        return `'${value.replace(/'/g, "''")}'`;
    }
    if (typeof value === 'boolean') {
        return value ? '1' : '0';
    }
    // drizzle-orm SQL expression (sql`...`) — rendered via the internals quarantine.
    return sqlExpressionToText(value) ?? String(value);
}

/**
 * Generate a `CREATE TABLE IF NOT EXISTS` DDL statement from a Drizzle SQLite table.
 *
 * Uses `getTableConfig` (drizzle-orm runtime introspection) to extract columns,
 * types, constraints, and foreign keys — no drizzle-kit CLI required.
 *
 * The output is deterministic: columns are emitted in definition order, identifiers
 * are double-quoted, and table constraints follow column definitions.
 *
 * @example
 * ```ts
 * const users = sqliteTable('users', { id: text('id').primaryKey() });
 * const ddl = generateCreateTableSql(users);
 * // CREATE TABLE IF NOT EXISTS "users" ("id" text PRIMARY KEY NOT NULL)
 * ```
 */
export function generateCreateTableSql(table: SQLiteTable): string {
    const config = getTableConfig(table);

    const columnDefs: string[] = [];
    const tableConstraints: string[] = [];

    // Track which columns participate in composite unique constraints
    const compositeUniqueCols = new Set<string>();
    for (const uc of config.uniqueConstraints) {
        if (uc.columns.length > 1) {
            for (const col of uc.columns) {
                compositeUniqueCols.add(col.name);
            }
        }
    }

    // Track which columns participate in composite primary keys
    const compositePkCols = new Set<string>();
    for (const pk of config.primaryKeys) {
        if (pk.columns.length > 1) {
            for (const col of pk.columns) {
                compositePkCols.add(col.name);
            }
        }
    }

    for (const col of config.columns) {
        const parts: string[] = [quoteIdent(col.name), col.getSQLType()];

        // Column-level PRIMARY KEY only for single-column PKs
        if (col.primary && !compositePkCols.has(col.name)) {
            parts.push('PRIMARY KEY');
        }
        if (col.notNull) {
            parts.push('NOT NULL');
        }
        // DEFAULT — only for SQL-level defaults (not runtime $defaultFn)
        if (col.hasDefault && col.default !== undefined) {
            const sqlDefault = defaultToSql(col.default);
            if (sqlDefault !== undefined) {
                parts.push(`DEFAULT ${sqlDefault}`);
            }
        }
        // UNIQUE at column level only when it's a single-column unique constraint
        if (col.isUnique && !compositeUniqueCols.has(col.name)) {
            parts.push('UNIQUE');
        }

        columnDefs.push(parts.join(' '));
    }

    // Composite PRIMARY KEY
    for (const pk of config.primaryKeys) {
        if (pk.columns.length > 1) {
            const pkCols = pk.columns.map((c) => quoteIdent(c.name)).join(', ');
            tableConstraints.push(`PRIMARY KEY (${pkCols})`);
        }
    }

    // Composite UNIQUE constraints
    for (const uc of config.uniqueConstraints) {
        if (uc.columns.length > 1) {
            const cols = uc.columns.map((c) => quoteIdent(c.name)).join(', ');
            tableConstraints.push(`UNIQUE (${cols})`);
        }
    }

    // Foreign keys
    for (const fk of config.foreignKeys) {
        const ref = fk.reference();
        const localCols = ref.columns.map((c) => quoteIdent(c.name)).join(', ');
        const foreignCols = ref.foreignColumns.map((c) => quoteIdent(c.name)).join(', ');
        const foreignTableName = getDrizzleTableName(ref.foreignTable);

        let constraint = `FOREIGN KEY (${localCols}) REFERENCES ${quoteIdent(foreignTableName)} (${foreignCols})`;
        if (fk.onDelete) {
            constraint += ` ON DELETE ${fk.onDelete}`;
        }
        if (fk.onUpdate) {
            constraint += ` ON UPDATE ${fk.onUpdate}`;
        }
        tableConstraints.push(constraint);
    }

    const allDefs = [...columnDefs, ...tableConstraints];
    return `CREATE TABLE IF NOT EXISTS ${quoteIdent(config.name)} (\n  ${allDefs.join(',\n  ')}\n)`;
}
