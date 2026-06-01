import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';

/**
 * Quote an identifier for use in SQL (double-quoted for SQLite compatibility).
 */
function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Extract the SQL string from a drizzle-orm SQL expression by walking its
 * internal `queryChunks` — StringChunk values plus Param placeholders.
 */
function sqlToString(chunks: Array<{ value?: unknown; input?: unknown }>): string {
    return chunks
        .map((chunk) => {
            // StringChunk — the literal SQL fragment
            if ('value' in chunk && typeof chunk.value === 'string') {
                return chunk.value;
            }
            // Param — use the input value if available
            if ('input' in chunk && chunk.input !== undefined) {
                return String(chunk.input);
            }
            return String(chunk.value ?? '?');
        })
        .join('');
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
    // drizzle-orm SQL expression (has queryChunks)
    if (typeof value === 'object' && value !== null && 'queryChunks' in value) {
        const chunks = (value as Record<string, unknown>).queryChunks as
            | Array<{ value?: unknown; input?: unknown }>
            | undefined;
        if (chunks) {
            return sqlToString(chunks);
        }
    }
    return String(value);
}

/**
 * Resolve a drizzle table object to its string name.
 */
function getTableName(table: Record<string, unknown>): string {
    // Drizzle tables store name at Symbol.for('drizzle:Name')
    const nameSym = Symbol.for('drizzle:Name');
    return String((table as unknown as Record<symbol, unknown>)[nameSym]);
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
        const foreignTableName = getTableName(ref.foreignTable as unknown as Record<string, symbol | unknown>);

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
