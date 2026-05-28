import { and, count as countFn, eq, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { DbClient } from './adapter.js';
import { BaseDao } from './base-dao.js';

/**
 * Type for tables compatible with EntityDao.
 * Must have standard columns: createdAt, updatedAt.
 */
export type EntityTable = SQLiteTable & {
    createdAt: SQLiteColumn;
    updatedAt: SQLiteColumn;
};

/**
 * Type for tables with soft delete support.
 */
export type SoftDeletableTable = EntityTable & {
    inUsed: SQLiteColumn;
};

/**
 * Type for primary key columns.
 */
export type PKColumn = SQLiteColumn;

/**
 * Generic CRUD base class for entity DAOs.
 *
 * Provides standard create, read, update, delete operations with:
 * - Type-safe public API using Drizzle's inference types
 * - Automatic soft delete filtering (if table has `inUsed` column)
 *
 * @typeParam TTable - The table type (must extend EntityTable)
 * @typeParam TPK - The primary key column type
 *
 * @example
 * ```ts
 * export class UsersDao extends EntityDao<typeof users, typeof users.id> {
 *     constructor(db: DbClient) {
 *         super(db, users, users.id, 'users');
 *     }
 *
 *     // Add entity-specific methods here
 *     async findByEmail(email: string) {
 *         return this.findBy(users.email, email);
 *     }
 * }
 * ```
 */
export class EntityDao<TTable extends EntityTable, TPK extends SQLiteColumn> extends BaseDao {
    constructor(
        db: DbClient,
        public readonly table: TTable,
        protected readonly primaryKey: TPK,
        protected readonly collectionName: string,
    ) {
        super(db);
    }

    /**
     * Check if the table has soft delete support (inUsed column).
     */
    protected get hasSoftDelete(): boolean {
        return 'inUsed' in this.table;
    }

    /**
     * Build a where condition that filters out soft-deleted records.
     * Returns undefined if the table doesn't support soft delete.
     */
    protected get activeCondition(): SQL | undefined {
        if (this.hasSoftDelete) {
            return eq((this.table as unknown as SoftDeletableTable).inUsed, 1);
        }
        return undefined;
    }

    /**
     * Create a new record.
     *
     * `createdAt` and `updatedAt` are auto-filled if not provided.
     *
     * @param data - The data to insert (createdAt/updatedAt optional).
     * @returns The created record.
     */
    async create(
        data: Omit<TTable['$inferInsert'], 'createdAt' | 'updatedAt'> & { createdAt?: number; updatedAt?: number },
    ): Promise<TTable['$inferSelect']> {
        const now = this.now();
        const record = {
            ...data,
            createdAt: (data as Record<string, unknown>).createdAt ?? now,
            updatedAt: (data as Record<string, unknown>).updatedAt ?? now,
        };

        await this.db.insert(this.table).values(record);

        return record as TTable['$inferSelect'];
    }

    /**
     * Find a record by its primary key.
     *
     * @param id - The primary key value.
     * @param includeDeleted - Whether to include soft-deleted records.
     * @returns The record if found, otherwise undefined.
     */
    async findById(id: string | number, includeDeleted = false): Promise<TTable['$inferSelect'] | undefined> {
        const conditions = [eq(this.primaryKey, id)];
        if (!includeDeleted && this.activeCondition) {
            conditions.push(this.activeCondition);
        }

        const result = await this.db
            .select()
            .from(this.table)
            .where(and(...conditions));

        return (result as TTable['$inferSelect'][])[0];
    }

    /**
     * Find all records.
     *
     * @param includeDeleted - Whether to include soft-deleted records.
     * @returns Array of records.
     */
    async findAll(includeDeleted = false): Promise<TTable['$inferSelect'][]> {
        const query = this.db.select().from(this.table);

        if (!includeDeleted && this.activeCondition) {
            return query.where(this.activeCondition);
        }

        return query;
    }

    /**
     * Update a record by its primary key.
     *
     * @param id - The primary key value.
     * @param data - The data to update.
     * @returns The updated record if found, otherwise undefined.
     */
    async update(
        id: string | number,
        data: Partial<TTable['$inferInsert']>,
    ): Promise<TTable['$inferSelect'] | undefined> {
        const now = this.now();
        const updateData = {
            ...data,
            updatedAt: now,
        };

        await this.db.update(this.table).set(updateData).where(eq(this.primaryKey, id));

        return this.findById(id);
    }

    /**
     * Delete a record by its primary key.
     *
     * @param id - The primary key value.
     * @param soft - Whether to perform a soft delete (default: true if table supports it).
     * @returns The deleted record (for soft delete), otherwise undefined.
     */
    async delete(id: string | number, soft?: boolean): Promise<TTable['$inferSelect'] | undefined> {
        const useSoftDelete = soft ?? this.hasSoftDelete;

        if (useSoftDelete && this.hasSoftDelete) {
            const now = this.now();
            await this.db
                .update(this.table)
                .set({ inUsed: 0, updatedAt: now } as Partial<TTable['$inferInsert']>)
                .where(eq(this.primaryKey, id));

            return this.findById(id, true);
        }

        await this.db.delete(this.table).where(eq(this.primaryKey, id));

        return undefined;
    }

    /**
     * Find a record by a specific column value.
     *
     * @param column - The column to search.
     * @param value - The value to match.
     * @param includeDeleted - Whether to include soft-deleted records.
     * @returns The record if found, otherwise undefined.
     */
    async findBy<TCol extends SQLiteColumn>(
        column: TCol,
        value: TCol['_']['data'],
        includeDeleted = false,
    ): Promise<TTable['$inferSelect'] | undefined> {
        const conditions = [eq(column, value)];
        if (!includeDeleted && this.activeCondition) {
            conditions.push(this.activeCondition);
        }

        const result = await this.db
            .select()
            .from(this.table)
            .where(and(...conditions));

        return (result as TTable['$inferSelect'][])[0];
    }

    /**
     * Find all records matching a specific column value.
     *
     * @param column - The column to search.
     * @param value - The value to match.
     * @param includeDeleted - Whether to include soft-deleted records.
     * @returns Array of matching records.
     */
    async findAllBy<TCol extends SQLiteColumn>(
        column: TCol,
        value: TCol['_']['data'],
        includeDeleted = false,
    ): Promise<TTable['$inferSelect'][]> {
        const conditions = [eq(column, value)];
        if (!includeDeleted && this.activeCondition) {
            conditions.push(this.activeCondition);
        }

        return this.db
            .select()
            .from(this.table)
            .where(and(...conditions));
    }

    /**
     * List records with pagination and optional filtering.
     *
     * @param options - List options (limit, offset, where).
     * @returns Array of records.
     */
    async list(
        options: { limit?: number; offset?: number; where?: SQL; includeDeleted?: boolean } = {},
    ): Promise<TTable['$inferSelect'][]> {
        const { limit = 100, offset = 0, where, includeDeleted = false } = options;
        const conditions: SQL[] = [];

        if (!includeDeleted && this.activeCondition) {
            conditions.push(this.activeCondition);
        }

        if (where) {
            conditions.push(where);
        }

        const query = this.db.select().from(this.table);

        if (conditions.length > 0) {
            return query
                .where(and(...conditions))
                .limit(limit)
                .offset(offset);
        }

        return query.limit(limit).offset(offset);
    }

    /**
     * Count records in the table.
     *
     * @param where - Optional filter condition.
     * @param includeDeleted - Whether to include soft-deleted records.
     * @returns The count of matching records.
     */
    async count(where?: SQL, includeDeleted = false): Promise<number> {
        const conditions: SQL[] = [];
        if (!includeDeleted && this.activeCondition) {
            conditions.push(this.activeCondition);
        }
        if (where) {
            conditions.push(where);
        }

        const query = this.db.select<{ value: number }>({ value: countFn() }).from(this.table);

        const result = conditions.length > 0 ? await query.where(and(...conditions)) : await query;

        return result[0]?.value ?? 0;
    }
}
