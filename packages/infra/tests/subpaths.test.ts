import { describe, expect, test } from 'bun:test';

import packageJson from '../package.json' with { type: 'json' };
import { runCliApplication } from '../src/application-cli';
import { DBJobQueue, DBQueueConsumer } from '../src/job-queue-db';
import { CloudflareSchedulerAdapter } from '../src/scheduler-cloudflare';
import { NodeSchedulerAdapter } from '../src/scheduler-node';

const manifest = packageJson as {
    dependencies: Record<string, string>;
    peerDependencies: Record<string, string>;
    peerDependenciesMeta: Record<string, unknown>;
};

describe('@gobing-ai/ts-infra adapter subpaths', () => {
    test('exports DB-backed queue adapters from the job-queue-db source entry', () => {
        expect(DBJobQueue).toBeDefined();
        expect(DBQueueConsumer).toBeDefined();
    });

    test('exports runtime-specific scheduler adapters from source entries', () => {
        expect(NodeSchedulerAdapter).toBeDefined();
        expect(CloudflareSchedulerAdapter).toBeDefined();
    });

    test('exports the CLI bootstrap from the application-cli source entry', () => {
        expect(runCliApplication).toBeDefined();
        expect(typeof runCliApplication).toBe('function');
    });

    test('declares export map entry for the CLI subpath', () => {
        expect(packageJson.exports['./application-cli']).toEqual({
            types: './dist/application-cli.d.ts',
            import: './dist/application-cli.js',
        });
    });

    test('declares package export map entries for adapter subpaths', () => {
        expect(packageJson.exports['./job-queue-db']).toEqual({
            types: './dist/job-queue-db.d.ts',
            import: './dist/job-queue-db.js',
        });
        expect(packageJson.exports['./scheduler-node']).toEqual({
            types: './dist/scheduler-node.d.ts',
            import: './dist/scheduler-node.js',
        });
        expect(packageJson.exports['./scheduler-cloudflare']).toEqual({
            types: './dist/scheduler-cloudflare.d.ts',
            import: './dist/scheduler-cloudflare.js',
        });
    });

    test('keeps DB adapter dependency optional for core consumers', () => {
        expect(manifest.dependencies['@gobing-ai/ts-db']).toBeUndefined();
        expect(manifest.peerDependencies['@gobing-ai/ts-db']).toBe('workspace:*');
        expect(manifest.peerDependenciesMeta['@gobing-ai/ts-db']).toEqual({ optional: true });
    });
});
