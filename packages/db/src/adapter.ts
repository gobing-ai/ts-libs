/**
 * Minimal D1 binding interface — avoids depending on @cloudflare/workers-types.
 */
interface D1Binding {
    prepare(sql: string): unknown;
    exec(sql: string): Promise<void>;
}

/**
 * Generic database table descriptor carrying select and insert type info.
 */
export interface DbTable<TSelect, TInsert = TSelect> {
    readonly $inferSelect: TSelect;
    readonly $inferInsert: TInsert;
}

type DbInsertBuilder<TTable extends DbTable<unknown, unknown>> = {
    values(values: TTable['$inferInsert'] | TTable['$inferInsert'][]): PromiseLike<unknown>;
};

interface DbSelectWhereResult<TTable extends DbTable<unknown, unknown>> extends PromiseLike<TTable['$inferSelect'][]> {
    limit(value: number): DbSelectWhereResult<TTable>;
    offset(value: number): DbSelectWhereResult<TTable>;
    orderBy(column: unknown): DbSelectWhereResult<TTable>;
}

type DbSelectFromResult<TTable extends DbTable<unknown, unknown>> = DbSelectWhereResult<TTable> & {
    where(condition: unknown): DbSelectWhereResult<TTable>;
};

type DbSelectBuilder = {
    from<TTable extends DbTable<unknown, unknown>>(table: TTable): DbSelectFromResult<TTable>;
};

type DbProjectionSelectBuilder<TProjection> = {
    from(table: DbTable<unknown, unknown>): PromiseLike<TProjection[]> & {
        where(condition: unknown): PromiseLike<TProjection[]>;
    };
};

interface DbUpdateResult {
    changes: number;
}

interface DbUpdateBuilder<TTable extends DbTable<unknown, unknown>> {
    set(values: Partial<TTable['$inferInsert']>): { where(condition: unknown): PromiseLike<DbUpdateResult> };
}

/**
 * Abstract database client with insert/select/update/delete query builders.
 */
export interface DbClient {
    insert<TTable extends DbTable<unknown, unknown>>(table: TTable): DbInsertBuilder<TTable>;
    select(): DbSelectBuilder;
    select<TProjection>(projection: Record<string, unknown>): DbProjectionSelectBuilder<TProjection>;
    update<TTable extends DbTable<unknown, unknown>>(table: TTable): DbUpdateBuilder<TTable>;
    delete<TTable extends DbTable<unknown, unknown>>(
        table: TTable,
    ): {
        where(condition: unknown): PromiseLike<DbUpdateResult>;
    };
}

/**
 * Database adapter providing a unified client, raw SQL exec, and lifecycle management.
 */
export interface DbAdapter {
    getDb(): DbClient;
    exec(sql: string): Promise<void>;
    /** Parameterized write (INSERT/UPDATE/DELETE) that returns no rows. */
    run(sql: string, ...params: unknown[]): Promise<void>;
    queryFirst<T>(sql: string, ...params: unknown[]): Promise<T | undefined>;
    queryAll<T>(sql: string, ...params: unknown[]): Promise<T[]>;
    close(): void;
}

/**
 * Discriminated-union config for creating a database adapter (bun-sqlite or D1).
 */
export type DbAdapterConfig =
    | {
          driver: 'bun-sqlite';
          url?: string;
          pragmas?: {
              journalMode?: string;
              synchronous?: string;
              foreignKeys?: string;
          };
      }
    | { driver: 'd1'; binding: D1Binding };

/**
 * Factory: creates the correct {@link DbAdapter} implementation based on driver config.
 */
export async function createDbAdapter(config: DbAdapterConfig): Promise<DbAdapter> {
    switch (config.driver) {
        case 'bun-sqlite': {
            const { BunSqliteAdapter } = await import('./adapters/bun-sqlite');
            return new BunSqliteAdapter({
                ...(config.url ? { databaseUrl: config.url } : {}),
                ...(config.pragmas ? { pragmas: config.pragmas } : {}),
            });
        }
        case 'd1': {
            const { D1Adapter } = await import('./adapters/d1');
            return new D1Adapter(config.binding as import('./adapters/d1').D1Binding);
        }
    }
}
