import { describe, expect, test } from 'bun:test';
import { D1NotConfiguredError } from '../src/db-errors';
import { cloudflareWorkersFactory } from '../src/runtime-cf';
import { nodeBunFactory } from '../src/runtime-node-bun';
import type { DatabaseConfig, RuntimeDbAdapter } from '../src/types';

describe('RuntimeFactory.createDbAdapter — DB seam', () => {
    // ── nodeBunFactory: Bun SQLite adapter ──────────────────────────────

    describe('nodeBunFactory.createDbAdapter', () => {
        test('returns a connected DbAdapter for an in-memory database', async () => {
            const adapter = await nodeBunFactory.createDbAdapter({ url: ':memory:' });
            expect(adapter).toBeDefined();
            expect(typeof adapter.exec).toBe('function');
            expect(typeof adapter.queryFirst).toBe('function');
            expect(typeof adapter.close).toBe('function');

            // Smoke: the adapter is connected and executes SQL (connection only,
            // no migration — caller owns schema).
            await adapter.exec('CREATE TABLE _smoke (id INTEGER PRIMARY KEY)');
            await adapter.run('INSERT INTO _smoke (id) VALUES (?)', 1);
            const row = await adapter.queryFirst<{ id: number }>('SELECT id FROM _smoke WHERE id = ?', 1);
            expect(row?.id).toBe(1);

            adapter.close();
        });

        test('the returned adapter satisfies the RuntimeDbAdapter type', async () => {
            const adapter: RuntimeDbAdapter = await nodeBunFactory.createDbAdapter({ url: ':memory:' });
            expect(adapter).toBeDefined();
            adapter.close();
        });
    });

    // ── capabilities ────────────────────────────────────────────────────

    describe('capabilities.hasSqlDatabase', () => {
        test('is true on nodeBunFactory', () => {
            expect(nodeBunFactory.capabilities.hasSqlDatabase).toBe(true);
        });

        test('is false on cloudflareWorkersFactory', () => {
            expect(cloudflareWorkersFactory.capabilities.hasSqlDatabase).toBe(false);
        });
    });

    // ── cloudflareWorkersFactory: D1 stub ───────────────────────────────

    describe('cloudflareWorkersFactory.createDbAdapter', () => {
        test('rejects with D1NotConfiguredError', async () => {
            const config: DatabaseConfig = { url: '.spur/spur.db' };
            await expect(cloudflareWorkersFactory.createDbAdapter(config)).rejects.toBeInstanceOf(D1NotConfiguredError);
        });

        test('the error carries the expected name', async () => {
            try {
                await cloudflareWorkersFactory.createDbAdapter({ url: ':memory:' });
                expect.unreachable('should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(D1NotConfiguredError);
                expect((error as D1NotConfiguredError).name).toBe('D1NotConfiguredError');
            }
        });
    });

    // ── D1NotConfiguredError ────────────────────────────────────────────

    describe('D1NotConfiguredError', () => {
        test('extends Error with the correct name', () => {
            const error = new D1NotConfiguredError();
            expect(error).toBeInstanceOf(Error);
            expect(error.name).toBe('D1NotConfiguredError');
            expect(error.message).toContain('D1');
        });

        test('accepts a custom message', () => {
            const error = new D1NotConfiguredError('custom reason');
            expect(error.message).toBe('custom reason');
        });
    });
});
