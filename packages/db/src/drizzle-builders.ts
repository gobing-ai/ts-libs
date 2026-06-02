/**
 * Shared structural types for drizzle's fluent query builders.
 *
 * `InternalDb` is typed as the bare drizzle union (ADR-005 keeps drizzle internal),
 * so its fluent builders (`insert().values().returning()`, `update().set().where()`,
 * `select(proj).from()...`) are not surfaced as call-shapes. Each DAO previously
 * re-declared these narrowings inline — three files independently describing the
 * same `update → set → where → returning` chain. Centralising them here means the
 * cast shape lives in one place: when drizzle's builder surface shifts, this file
 * changes, not every DAO.
 *
 * These are deliberately minimal — each type narrows only the chain a DAO actually
 * invokes. Table-specific projections (`select({ status, count })`) stay local to
 * their DAO; only the recurring chain skeletons live here.
 *
 * @internal
 */

/** Terminal `.returning()` returning the written rows. */
export interface ReturningRows {
    returning: () => Promise<unknown[]>;
}

/** `insert(table).values(record)` → returning, with optional upsert. */
export interface InsertBuilder {
    values: (record: unknown) => ReturningRows & {
        onConflictDoUpdate: (cfg: { target: unknown; set: unknown }) => ReturningRows;
    };
}

/** `update(table).set(data).where(cond)` → `.returning()` rows. */
export interface UpdateReturningDb {
    update: (table: unknown) => {
        set: (data: unknown) => {
            where: (cond: unknown) => ReturningRows;
        };
    };
}

/** `update(table).set(data).where(cond)` → void (no rows). */
export interface UpdateVoidDb {
    update: (table: unknown) => {
        set: (data: unknown) => {
            where: (cond: unknown) => Promise<unknown>;
        };
    };
}

/** `update(table).set(data).where(cond)` → `{ changes }` (affected-row count). */
export interface UpdateChangesDb {
    update: (table: unknown) => {
        set: (data: unknown) => {
            where: (cond: unknown) => Promise<{ changes: number }>;
        };
    };
}

/** `update(table).set(data).where(cond)` → arbitrary single condition (no projection). */
export interface SimpleUpdateDb {
    update: (table: unknown) => {
        set: (data: unknown) => {
            where: (cond: unknown) => ReturningRows;
        };
    };
}

/** `select(projection).from(table)` exposing `.where(...)` and `.groupBy(...)` terminals. */
export interface SelectProjectionDb {
    select: (projection: unknown) => {
        from: (table: unknown) => {
            where: (cond: unknown) => Promise<unknown[]>;
            groupBy: (group: unknown) => Promise<unknown[]>;
        };
    };
}

/** `select().from(table).where(cond).orderBy(o).limit(n)` — the ready-rows read chain. */
export interface SelectOrderedLimitDb {
    select: () => {
        from: (table: unknown) => {
            where: (cond: unknown) => {
                orderBy: (order: unknown) => { limit: (limit: number) => Promise<unknown[]> };
            };
        };
    };
}

/** `select(count).from(table)` that is awaitable and chainable with `.where(...)`. */
export type CountQuery = Promise<unknown[]> & {
    where: (condition: unknown) => Promise<unknown[]>;
};

/** `select({ value: count() }).from(table)` → awaitable count, optionally filtered. */
export interface CountSelectDb {
    select: (projection: unknown) => {
        from: (table: unknown) => CountQuery;
    };
}
