/**
 * Quarantine for the *unversioned* drizzle-orm internal shapes ts-db reaches into
 * for DDL generation.
 *
 * Everything else in ts-db consumes drizzle's public API (`getTableConfig`,
 * column accessors). These two helpers are the only places that touch private
 * structure — the SQL-expression `queryChunks` array and the
 * `Symbol.for('drizzle:Name')` table-name slot — neither of which is covered by
 * drizzle's semver contract. Keeping both here means a drizzle bump that changes
 * an internal shape breaks in ONE file with ONE focused test, instead of silently
 * mis-generating DDL across `ddl.ts`. If this module starts failing after an
 * upgrade, the fix lives here.
 */

/** A drizzle SQL expression's internal chunk: a literal fragment or a bound param. */
interface SqlChunk {
    value?: unknown;
    input?: unknown;
}

/**
 * Render a drizzle `sql\`...\`` expression to its literal SQL text by walking its
 * internal `queryChunks`. Used to emit SQL-level column defaults
 * (e.g. `DEFAULT (unixepoch())`) into generated DDL.
 *
 * Returns `undefined` when `value` is not a drizzle SQL expression with chunks,
 * so callers can fall through to their primitive/`String()` handling.
 */
export function sqlExpressionToText(value: unknown): string | undefined {
    if (typeof value !== 'object' || value === null || !('queryChunks' in value)) {
        return undefined;
    }
    const chunks = (value as Record<string, unknown>).queryChunks as SqlChunk[] | undefined;
    if (!chunks) return undefined;

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

/** Resolve a drizzle table object to its declared name (stored at a private symbol). */
export function getDrizzleTableName(table: object): string {
    const nameSym = Symbol.for('drizzle:Name');
    return String((table as Record<symbol, unknown>)[nameSym]);
}
