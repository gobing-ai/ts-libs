import { describe, expect, test } from 'bun:test';
import { D1Adapter, type D1Binding } from '../../src/adapters/d1';

function mockBinding(opts?: { execCalled?: () => void; firstResult?: unknown; allResults?: unknown[] }): D1Binding {
    return {
        prepare(_sql: string) {
            return {
                bind(..._params: unknown[]) {
                    return {
                        all: async <T>(): Promise<{ results: T[]; success: boolean }> => ({
                            results: (opts?.allResults ?? []) as T[],
                            success: true,
                        }),
                        run: async () => ({ results: [] as unknown[], success: true }),
                        raw: async <T>(): Promise<T[]> => (opts?.allResults ?? []) as T[],
                        first: async <T>(): Promise<T | null> => (opts?.firstResult as T) ?? null,
                    };
                },
                first: async <T>(): Promise<T | null> => (opts?.firstResult as T) ?? null,
                run: async () => ({ results: [] as unknown[], success: true }),
            };
        },
        exec: async (_sql: string) => {
            opts?.execCalled?.();
        },
    };
}

describe('D1Adapter', () => {
    test('constructor creates adapter', () => {
        const adapter = new D1Adapter(mockBinding());
        expect(adapter).toBeDefined();
    });

    test('getDb returns DbClient', () => {
        const adapter = new D1Adapter(mockBinding());
        const db = adapter.getDb();
        expect(db).toBeDefined();
    });

    test('getBinding returns the binding', () => {
        const b = mockBinding();
        const adapter = new D1Adapter(b);
        expect(adapter.getBinding()).toBe(b);
    });

    test('exec calls binding.exec', async () => {
        let called = false;
        const adapter = new D1Adapter(
            mockBinding({
                execCalled: () => {
                    called = true;
                },
            }),
        );
        await adapter.exec('CREATE TABLE test (id INTEGER)');
        expect(called).toBeTrue();
    });

    test('run without params', async () => {
        const adapter = new D1Adapter(mockBinding());
        await expect(adapter.run('INSERT INTO t VALUES (1)')).resolves.toBeUndefined();
    });

    test('run with params', async () => {
        const adapter = new D1Adapter(mockBinding());
        await expect(adapter.run('INSERT INTO t VALUES (?, ?)', 1, 'hello')).resolves.toBeUndefined();
    });

    test('queryFirst returns result', async () => {
        const adapter = new D1Adapter(mockBinding({ firstResult: { id: 1, name: 'test' } }));
        const result = await adapter.queryFirst<{ id: number; name: string }>('SELECT * FROM t WHERE id = ?', 1);
        expect(result).toEqual({ id: 1, name: 'test' });
    });

    test('queryFirst returns undefined when first returns null', async () => {
        const adapter = new D1Adapter(mockBinding({ firstResult: null }));
        const result = await adapter.queryFirst<{ id: number }>('SELECT * FROM t WHERE id = ?', 999);
        expect(result).toBeUndefined();
    });

    test('queryAll returns results', async () => {
        const data = [
            { id: 1, name: 'a' },
            { id: 2, name: 'b' },
        ];
        const adapter = new D1Adapter(mockBinding({ allResults: data }));
        const result = await adapter.queryAll<{ id: number; name: string }>('SELECT * FROM t');
        expect(result).toEqual(data);
    });

    test('queryAll returns empty array when results null', async () => {
        const adapter = new D1Adapter(mockBinding({ allResults: null as unknown as unknown[] }));
        const result = await adapter.queryAll<unknown>('SELECT * FROM t');
        expect(result).toEqual([]);
    });

    test('close is no-op', () => {
        const adapter = new D1Adapter(mockBinding());
        expect(() => adapter.close()).not.toThrow();
    });
});
