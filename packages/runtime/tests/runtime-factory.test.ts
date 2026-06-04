import { describe, expect, test } from 'bun:test';
import { nodeBunFactory } from '../src/runtime-node-bun';

describe('nodeBunFactory', () => {
    test('runtimeName is node-bun', () => {
        expect(nodeBunFactory.runtimeName).toBe('node-bun');
    });

    test('capabilities indicate filesystem and process', () => {
        expect(nodeBunFactory.capabilities.hasFilesystem).toBe(true);
        expect(nodeBunFactory.capabilities.hasProcessExecution).toBe(true);
    });

    test('createFileSystem returns a filesystem', () => {
        const fs = nodeBunFactory.createFileSystem();
        expect(fs.getProjectRoot()).toBeString();
    });

    test('createProcessExecutor returns an executor', () => {
        const exec = nodeBunFactory.createProcessExecutor();
        expect(typeof exec.run).toBe('function');
        expect(typeof exec.runStreaming).toBe('function');
    });
});
