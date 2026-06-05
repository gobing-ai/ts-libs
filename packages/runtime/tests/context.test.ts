import { beforeAll, describe, expect, test } from 'bun:test';

import { buildConfigFromObject } from '../src/config';
import {
    createRuntimeContext,
    createRuntimeContextFromFactory,
    RuntimeContext,
    type RuntimeServiceMap,
} from '../src/context';
import { createCfFileSystem } from '../src/file-system-cf';
import { _resetRuntimeFactory } from '../src/platform';
import { cloudflareWorkersFactory } from '../src/runtime-cf';

interface Services extends RuntimeServiceMap {
    greeting: { value: string };
    disposable: { disposed: boolean; dispose(): void };
}

describe('RuntimeContext', () => {
    test('creates a context with default config and filesystem services', () => {
        const context = createRuntimeContext();

        expect(context.scope).toBe('process');
        expect(context.runtimeName).toBe('node-bun');
        expect(context.require('config').app.port).toBe(3000);
        expect(context.has('fileSystem')).toBe(true);
    });

    describe('createRuntimeContextFromFactory', () => {
        beforeAll(() => {
            _resetRuntimeFactory();
        });

        test('creates a context with auto-detected platform services', async () => {
            const context = await createRuntimeContextFromFactory();

            expect(context.scope).toBe('process');
            expect(context.runtimeName).toBe('node-bun');
            expect(context.capabilities.hasFilesystem).toBe(true);
            expect(context.capabilities.hasProcessExecution).toBe(true);
            expect(context.has('config')).toBe(true);
            expect(context.has('fileSystem')).toBe(true);
            expect(context.has('processExecutor')).toBe(true);
            expect(context.require('config').app.port).toBe(3000);
        });

        test('does not register processExecutor when runtime capabilities do not support processes', () => {
            const context = new RuntimeContext<RuntimeServiceMap>({
                runtimeName: cloudflareWorkersFactory.runtimeName,
                capabilities: cloudflareWorkersFactory.capabilities,
                services: {
                    config: buildConfigFromObject({}),
                    fileSystem: cloudflareWorkersFactory.createFileSystem(),
                },
            });

            expect(context.capabilities.hasProcessExecution).toBe(false);
            expect(context.has('processExecutor')).toBe(false);
        });
    });

    test('registers, gets, requires, and disposes typed services', async () => {
        const disposable = {
            disposed: false,
            dispose() {
                this.disposed = true;
            },
        };
        const context = new RuntimeContext<Services>({
            scope: 'test',
            runtimeName: 'test',
            services: {
                config: buildConfigFromObject({ app: { name: 'runtime-test' } }),
                fileSystem: createCfFileSystem(),
                greeting: { value: 'hello' },
                disposable,
            },
        });

        expect(context.get('greeting')?.value).toBe('hello');
        expect(context.require('fileSystem').getProjectRoot()).toBe('/bundle');
        await context.dispose();
        expect(disposable.disposed).toBe(true);
    });

    test('throws clear errors for missing required services', () => {
        const context = createRuntimeContext();

        expect(() => context.require('missing')).toThrow('Runtime service "missing" is unavailable');
    });

    test('disposes all services and aggregates errors', async () => {
        let disposed1 = false;
        let disposed2 = false;
        const d1 = {
            dispose() {
                disposed1 = true;
                throw new Error('disposer 1 failed');
            },
        };
        const d2 = {
            dispose() {
                disposed2 = true;
            },
        };
        const context = createRuntimeContext({
            services: {
                d1,
                d2,
            },
        });
        await expect(context.dispose()).rejects.toThrow('Failed to dispose some services');
        expect(disposed1).toBe(true);
        expect(disposed2).toBe(true);
    });
});
