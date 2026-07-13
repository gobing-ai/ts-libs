import { describe, expect, test } from 'bun:test';

import {
    buildConfigFromObject,
    createCfFileSystem,
    createNodeFileSystem,
    createRuntimeContext,
    type FileSystem,
    NodeProcessExecutor,
    ProcessExecutor,
} from '../src/index';

describe('@gobing-ai/ts-runtime barrel', () => {
    test('exports filesystem, process, context, and config APIs', () => {
        const nodeFs: FileSystem = createNodeFileSystem();
        const cfFs: FileSystem = createCfFileSystem();
        expect(typeof nodeFs.resolve('package.json')).toBe('string');
        expect(typeof cfFs.getProjectRoot()).toBe('string');
        expect(new ProcessExecutor()).toBeInstanceOf(NodeProcessExecutor);
        expect(createRuntimeContext().require('config').app.port).toBe(3000);
        expect(buildConfigFromObject({ app: { env: 'test' } }).app.env).toBe('test');
    });

    test('exports the canonical union-return FileSystem type from the root barrel', () => {
        const fs: FileSystem = createNodeFileSystem();

        expect(typeof fs.resolve('package.json')).toBe('string');
        expect(typeof fs.getProjectRoot()).toBe('string');
    });
});
