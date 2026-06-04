import { describe, expect, test } from 'bun:test';
import { _resetRuntimeFactory, isCloudflareWorkerRuntime, loadRuntimeFactory } from '../src/platform';

describe('platform', () => {
    test('isCloudflareWorkerRuntime returns false on Node/Bun', () => {
        expect(isCloudflareWorkerRuntime()).toBe(false);
    });

    test('loadRuntimeFactory returns node-bun factory', async () => {
        const factory = await loadRuntimeFactory();
        expect(factory.runtimeName).toBe('node-bun');
        expect(factory.capabilities.hasFilesystem).toBe(true);
        expect(factory.capabilities.hasProcessExecution).toBe(true);
    });

    test('loadRuntimeFactory caches result', async () => {
        const first = await loadRuntimeFactory();
        const second = await loadRuntimeFactory();
        expect(first).toBe(second);
    });

    test('_resetRuntimeFactory clears cache', async () => {
        const first = await loadRuntimeFactory();
        _resetRuntimeFactory();
        const second = await loadRuntimeFactory();
        expect(first.capabilities).toEqual(second.capabilities);
    });
});
