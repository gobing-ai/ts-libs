import { and, count as countFn, eq, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { DbAdapter } from './adapter';
import { BaseDao } from './base-dao';
import { compilePredicate, type OrderTerm, type Predicate } from './query-spec';

/**
 * Type for tables compatible with EntityDao.
 * Must have standard columns: createdAt, updatedAt.
 */
export type EntityTable = SQLiteTable & {
    createdAt: SQLiteColumn;
    updatedAt: SQLiteColumn;
};

/** Type for tables with soft delete support. */
export type SoftDeletableTable = EntityTable & {
    inUsed: SQLiteColumn;
};

/** Type for primary key columns (single column or a tuple for composite keys). */
export type PKColumn = SQLiteColumn;

/** A primary key value: a single value, or a tuple for composite keys. */
export type PKValue = string | number | (string | number)[];

/** Options for the structured `list` operation. */
export interface EntityListSpec {
    where?: Predicate;
    orderBy?: readonly OrderTerm[];
    limit?: number;
    offset?: number;
    includeDeleted?: boolean;
}

/** Options for keyset/cursor pagination. */
export interface CursorListSpec {
    /** Opaque cursor from a previous page (the last row's keyset value). */
    cursor?: string | number;
    /** Column the cursor walks (must be unique + ordered, e.g. the primary key). */
    cursorColumn: SQLiteColumn;
    /** Page size. */
    limit: number;
    where?: Predicate;
    direction?: 'asc' | 'desc';
    includeDeleted?: boolean;
}

/**
 * Generic CRUD base class for entity DAOs — the STRUCTURED tier of the facade.
 *
 * Extends {@link BaseDao} (raw tier) with typed create/read/update/delete over a
 * single table, using RETURNING, drizzle-free predicate filters, soft-delete
 * auto-filtering, batch insert, upsert, and cursor pagination. drizzle is hidden
 * entirely — consumers use ts-db vocabulary. (G1/G3)
 *
 * @typeParam TTable - The table type (must extend EntityTable).
 * @typeParam TPK - The primary key column type.
 *
 * @example
 * ```ts
 * class UsersDao extends EntityDao<typeof users, typeof users.id> {
 *     constructor(adapter: DbAdapter) {
 *         super(adapter, users, [users.id], 'users');
 *     }
 *     findByEmail(email: string) {
 *         return this.findBy(users.email, email);
 *     }
 * }
 * ```
 */
export class EntityDao<TTable extends EntityTable, TPK extends SQLiteColumn> extends BaseDao {
    readonly table: TTable;
    /** Primary key columns. A single-element array for single-PK tables, multiple for composite. */
    protected readonly primaryKey: SQLiteColumn[];
    protected readonly collectionName: string;

    constructor(adapter: DbAdapter, table: TTable, primaryKey: TPK | SQLiteColumn[], collectionName: string) {
        super(adapter);
        this.table = table;
        this.primaryKey = Array.isArray(primaryKey) ? primaryKey : [primaryKey];
        this.collectionName = collectionName;
    }

    /** Check if the table has soft delete support (inUsed column). */
    protected get hasSoftDelete(): boolean {
        return 'inUsed' in this.table;
    }

    /** Condition filtering out soft-deleted rows, or undefined when unsupported. */
    protected get activeCondition(): SQL | undefined {
        if (this.hasSoftDelete) {
            return eq((this.table as unknown as SoftDeletableTable).inUsed, 1);
        }
        return undefined;
    }

    /** Build the where-condition matching a primary key value (single or composite). */
    private pkCondition(id: PKValue): SQL {
        const values = Array.isArray(id) ? id : [id];
        if (values.length !== this.primaryKey.length) {
            throw new Error(
                `${this.collectionName}: primary key expects ${this.primaryKey.length} value(s), got ${values.length}`,
            );
        }
        const parts = this.primaryKey.map((col, i) => eq(col, values[i]));
        return parts.length === 1 ? (parts[0] as SQL) : (and(...parts) as SQL);
    }

    private get insertBuilder() {
        return this.db.insert(this.table as unknown as Parameters<typeof this.db.insert>[0]);
    }

    /**
     * Create a new record. `createdAt`/`updatedAt` are auto-filled if absent.
     * Returns the row as written by the database (RETURNING).
     */
    async create(
        data: Omit<TTable['$inferInsert'], 'createdAt' | 'updatedAt'> & { createdAt?: number; updatedAt?: number },
    ): Promise<TTable['$inferSelect']> {
        const now = this.now();
        const record = { createdAt: now, updatedAt: now, ...data };
        const rows = (await (
            this.insertBuilder.values(record) as unknown as { returning: () => Promise<unknown[]> }
        ).returning()) as TTable['$inferSelect'][];
        return rows[0] as TTable['$inferSelect'];
    }

    /**
     * Insert many records in a single multi-VALUES statement (efficient for ETL).
     * Returns the written rows (RETURNING).
     */
    async createMany(
        data: (Omit<TTable['$inferInsert'], 'createdAt' | 'updatedAt'> & {
            createdAt?: number;
            updatedAt?: number;
        })[],
    ): Promise<TTable['$inferSelect'][]> {
        if (data.length === 0) return [];
        const now = this.now();
        const records = data.map((d) => ({ createdAt: now, updatedAt: now, ...d }));
        return (await (
            this.insertBuilder.values(records) as unknown as { returning: () => Promise<unknown[]> }
        ).returning()) as TTable['$inferSelect'][];
    }

    /**
     * Insert or update on conflict. `conflictColumns` identify the unique target;
     * `update` (or all non-conflict columns) are written on conflict. Returns the row.
     */
    async upsert(
        data: Omit<TTable['$inferInsert'], 'createdAt' | 'updatedAt'> & { createdAt?: number; updatedAt?: number },
        conflictColumns: SQLiteColumn[],
        updateColumns?: Partial<TTable['$inferInsert']>,
    ): Promise<TTable['$inferSelect']> {
        const now = this.now();
        const record = { createdAt: now, updatedAt: now, ...data };
        const setOnConflict = { ...(updateColumns ?? data), updatedAt: now };
        const rows = (await (
            this.insertBuilder.values(record) as unknown as {
                onConflictDoUpdate: (cfg: { target: SQLiteColumn[]; set: unknown }) => {
                    returning: () => Promise<unknown[]>;
                };
            }
        )
            .onConflictDoUpdate({ target: conflictColumns, set: setOnConflict })
            .returning()) as TTable['$inferSelect'][];
        return rows[0] as TTable['$inferSelect'];
    }

    /** Find a record by its primary key (single value or composite tuple). */
    async findById(id: PKValue, includeDeleted = false): Promise<TTable['$inferSelect'] | undefined> {
        const conditions: SQL[] = [this.pkCondition(id)];
        if (!includeDeleted && this.activeCondition) conditions.push(this.activeCondition);
        const result = (await this.db
            .select()
            .from(this.table)
            .where(and(...conditions))) as TTable['$inferSelect'][];
        return result[0];
    }

    /** Find all records (optionally including soft-deleted). */
    async findAll(includeDeleted = false): Promise<TTable['$inferSelect'][]> {
        return this.list({ includeDeleted });
    }

    /** Find the first record matching a column value. */
    async findBy<TCol extends SQLiteColumn>(
        column: TCol,
        value: TCol['_']['data'],
        includeDeleted = false,
    ): Promise<TTable['$inferSelect'] | undefined> {
        const rows = await this.list({ where: { col: column, op: 'eq', value }, limit: 1, includeDeleted });
        return rows[0];
    }

    /** Find all records matching a column value. */
    async findAllBy<TCol extends SQLiteColumn>(
        column: TCol,
        value: TCol['_']['data'],
        includeDeleted = false,
    ): Promise<TTable['$inferSelect'][]> {
        return this.list({ where: { col: column, op: 'eq', value }, includeDeleted });
    }

    /** Update a record by primary key. `updatedAt` is refreshed. Returns the updated row. */
    async update(id: PKValue, data: Partial<TTable['$inferInsert']>): Promise<TTable['$inferSelect'] | undefined> {
        const updateData = { ...data, updatedAt: this.now() };
        const rows = (await (
            this.db.update(this.table as unknown as Parameters<typeof this.db.update>[0]).set(updateData) as unknown as {
                where: (c: SQL) => { returning: () => Promise<unknown[]> };
            }
        )
            .where(this.pkCondition(id))
            .returning()) as TTable['$inferSelect'][];
        return rows[0];
    }

    /** Delete a record by primary key. Soft-deletes when the table supports it (default). */
    async delete(id: PKValue, soft?: boolean): Promise<TTable['$inferSelect'] | undefined> {
        const useSoftDelete = soft ?? this.hasSoftDelete;
        if (useSoftDelete && this.hasSoftDelete) {
            return this.update(id, { inUsed: 0 } as Partial<TTable['$inferInsert']>);
        }
        await (
            this.db.delete(this.table as unknown as Parameters<typeof this.db.delete>[0]) as unknown as {
                where: (c: SQL) => Promise<unknown>;
            }
        ).where(this.pkCondition(id));
        return undefined;
    }

    /** List records with predicate filter, ordering, and offset pagination. */
    async list(spec: EntityListSpec = {}): Promise<TTable['$inferSelect'][]> {
        const where = this.withActive(spec.where, spec.includeDeleted);
        return this.query<TTable['$inferSelect']>(this.table, {
            ...(where ? { where } : {}),
            ...(spec.orderBy ? { orderBy: spec.orderBy } : {}),
            ...(spec.limit !== undefined ? { limit: spec.limit } : {}),
            ...(spec.offset !== undefined ? { offset: spec.offset } : {}),
        });
    }

    /** List one keyset page; returns the rows and the cursor for the next page. */
    async listByCursor(spec: CursorListSpec): Promise<{ rows: TTable['$inferSelect'][]; nextCursor?: string | number }> {
        const dir = spec.direction ?? 'asc';
        const filters: Predicate[] = [];
        if (spec.where) filters.push(spec.where);
        if (spec.cursor !== undefined) {
            filters.push({ col: spec.cursorColumn, op: dir === 'asc' ? 'gt' : 'lt', value: spec.cursor });
        }
        const where = this.withActive(filters.length > 0 ? { and: filters } : undefined, spec.includeDeleted);
        const rows = await this.query<TTable['$inferSelect']>(this.table, {
            ...(where ? { where } : {}),
            orderBy: [{ col: spec.cursorColumn, dir }],
            limit: spec.limit,
        });
        const last = rows[rows.length - 1] as Record<string, unknown> | undefined;
        const nextCursor =
            rows.length === spec.limit && last
                ? (last[(spec.cursorColumn as unknown as { name: string }).name] as string | number)
                : undefined;
        return nextCursor !== undefined ? { rows, nextCursor } : { rows };
    }

    /** Count records matching an optional predicate. */
    async count(where?: Predicate, includeDeleted = false): Promise<number> {
        const condition = this.withActive(where, includeDeleted);
        const compiled = condition ? compilePredicate(condition) : undefined;
        const base = (
            this.db as unknown as {
                select: (p: unknown) => { from: (t: unknown) => { where: (c: SQL) => Promise<unknown[]> } };
            }
        )
            .select({ value: countFn() })
            .from(this.table);
        const result = (await (compiled ? base.where(compiled) : (base as unknown as Promise<unknown[]>))) as {
            value: number;
        }[];
        return result[0]?.value ?? 0;
    }

    /** Combine a caller predicate with the soft-delete active filter. */
    private withActive(where: Predicate | undefined, includeDeleted?: boolean): Predicate | undefined {
        if (includeDeleted || !this.hasSoftDelete) return where;
        const active: Predicate = { col: (this.table as unknown as SoftDeletableTable).inUsed, op: 'eq', value: 1 };
        if (!where) return active;
        return { and: [where, active] };
    }
}
