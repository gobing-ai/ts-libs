import { describe, expect, test } from 'bun:test';

import {
    buildConfigFromObject,
    CloudflareFileSystem,
    createRuntimeContext,
    NodeFileSystem,
    ProcessExecutor,
} from '../src/index';

describe('@gobing-ai/ts-runtime barrel', () => {
    test('exports filesystem, process, context, and config APIs', () => {
        expect(new NodeFileSystem()).toBeInstanceOf(NodeFileSystem);
        expect(new CloudflareFileSystem()).toBeInstanceOf(CloudflareFileSystem);
        expect(new ProcessExecutor()).toBeInstanceOf(ProcessExecutor);
        expect(createRuntimeContext().require('config').app.port).toBe(3000);
        expect(buildConfigFromObject({ app: { env: 'test' } }).app.env).toBe('test');
    });
});
