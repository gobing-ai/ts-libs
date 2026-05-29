import { describe, expect, test } from 'bun:test';
import type { spawnSync } from 'node:child_process';
import {
    createAggregateReleaseTag,
    createReleaseTag,
    isAlreadyPublishedError,
    npmPublish,
    npmViewVersion,
    parseReleaseTag,
    selectPackagesForPublish,
    sortPackagesByDependencyOrder,
} from '../lib/release';
import type { WorkspacePackage } from '../lib/workspace';
import { findWorkspacePackages } from '../lib/workspace';

function pkg(name: string, dir: string, dependencies: Record<string, string> = {}): WorkspacePackage {
    return {
        path: `${dir}/package.json`,
        dir,
        name,
        version: '0.1.5',
        private: false,
        dependencies,
    };
}

describe('release tags', () => {
    test('accepts any workspace package name under @gobing-ai/ts-', () => {
        expect(parseReleaseTag('@gobing-ai/ts-cache-v0.1.5')).toEqual({
            name: '@gobing-ai/ts-cache',
            version: '0.1.5',
        });
        expect(parseReleaseTag('@gobing-ai/ts-cloudflare-kv-cache-v1.2.3-beta.1+build.7')).toEqual({
            name: '@gobing-ai/ts-cloudflare-kv-cache',
            version: '1.2.3-beta.1+build.7',
        });
    });

    test('rejects tags outside the release namespace', () => {
        expect(parseReleaseTag('@gobing-ai/not-ts-cache-v0.1.5')).toBeUndefined();
        expect(parseReleaseTag('@gobing-ai/ts-cache-0.1.5')).toBeUndefined();
    });

    test('creates release tags from package metadata', () => {
        expect(createReleaseTag(pkg('@gobing-ai/ts-cache', 'packages/cache'), '0.1.5')).toBe(
            '@gobing-ai/ts-cache-v0.1.5',
        );
        expect(createAggregateReleaseTag('0.1.5')).toBe('@gobing-ai/ts-libs-v0.1.5');
    });
});

describe('selectPackagesForPublish', () => {
    test('selects the package named by a generic release tag', async () => {
        const packages = [
            pkg('@gobing-ai/ts-utils', 'packages/utils'),
            pkg('@gobing-ai/ts-cloudflare-kv-cache', 'packages/cloudflare-kv-cache'),
        ];

        await expect(
            selectPackagesForPublish(packages, 'tag', '@gobing-ai/ts-cloudflare-kv-cache-v0.1.5'),
        ).resolves.toEqual([packages[1]]);
    });

    test('fails when the tag version does not match the manifest', async () => {
        const packages = [pkg('@gobing-ai/ts-cache', 'packages/cache')];

        await expect(selectPackagesForPublish(packages, 'tag', '@gobing-ai/ts-cache-v0.1.6')).rejects.toThrow(
            'expects @gobing-ai/ts-cache@0.1.6',
        );
    });

    test('fails when tag metadata is incomplete or unsupported', async () => {
        const packages = [pkg('@gobing-ai/ts-cache', 'packages/cache')];

        await expect(selectPackagesForPublish(packages, 'tag', undefined)).rejects.toThrow(
            'GITHUB_REF_TYPE is "tag" but GITHUB_REF_NAME is empty',
        );

        await expect(selectPackagesForPublish(packages, 'tag', 'not-a-release-tag')).rejects.toThrow(
            'unsupported release tag',
        );
    });

    test('fails when the release tag does not map to a publishable workspace package', async () => {
        const privatePackage = pkg('@gobing-ai/ts-private', 'packages/private');
        privatePackage.private = true;
        const packages = [privatePackage];

        await expect(selectPackagesForPublish(packages, 'tag', '@gobing-ai/ts-missing-v0.1.5')).rejects.toThrow(
            'no workspace package has that name',
        );

        await expect(selectPackagesForPublish(packages, 'tag', '@gobing-ai/ts-private-v0.1.5')).rejects.toThrow(
            'names private package',
        );
    });

    test('workflow dispatch selects all publishable packages in dependency order', async () => {
        const packages = [
            pkg('@gobing-ai/ts-app', 'packages/app', {
                '@gobing-ai/ts-db': '^0.1.0',
                '@gobing-ai/ts-utils': '^0.1.0',
            }),
            pkg('@gobing-ai/ts-db', 'packages/db', { '@gobing-ai/ts-runtime': '^0.1.0' }),
            pkg('@gobing-ai/ts-runtime', 'packages/runtime', { '@gobing-ai/ts-utils': '^0.1.0' }),
            pkg('@gobing-ai/ts-utils', 'packages/utils'),
        ];

        const selected = await selectPackagesForPublish(packages, undefined, undefined);

        expect(selected.map((workspacePackage) => workspacePackage.name)).toEqual([
            '@gobing-ai/ts-utils',
            '@gobing-ai/ts-runtime',
            '@gobing-ai/ts-db',
            '@gobing-ai/ts-app',
        ]);
    });

    test('aggregate release tag selects all publishable packages in dependency order', async () => {
        const packages = [
            pkg('@gobing-ai/ts-libs', '.', {
                '@gobing-ai/ts-db': '^0.1.0',
                '@gobing-ai/ts-utils': '^0.1.0',
            }),
            pkg('@gobing-ai/ts-db', 'packages/db', { '@gobing-ai/ts-runtime': '^0.1.0' }),
            pkg('@gobing-ai/ts-runtime', 'packages/runtime', { '@gobing-ai/ts-utils': '^0.1.0' }),
            pkg('@gobing-ai/ts-utils', 'packages/utils'),
        ];
        packages[0].private = true;

        const selected = await selectPackagesForPublish(packages, 'tag', '@gobing-ai/ts-libs-v0.1.5');

        expect(selected.map((workspacePackage) => workspacePackage.name)).toEqual([
            '@gobing-ai/ts-utils',
            '@gobing-ai/ts-runtime',
            '@gobing-ai/ts-db',
        ]);
    });

    test('aggregate release tag validates the root manifest version', async () => {
        const packages = [pkg('@gobing-ai/ts-libs', '.')];
        packages[0].private = true;

        await expect(selectPackagesForPublish(packages, 'tag', '@gobing-ai/ts-libs-v0.1.6')).rejects.toThrow(
            'expects @gobing-ai/ts-libs@0.1.6',
        );
    });
});

describe('npm publish helpers', () => {
    test('detects already-published npm view results', () => {
        const okSpawn = (() => ({ status: 0, stdout: '0.1.5\n', stderr: '' })) as typeof spawnSync;
        const missingSpawn = (() => ({ status: 1, stdout: '', stderr: 'not found' })) as typeof spawnSync;

        expect(npmViewVersion('@gobing-ai/ts-cache', '0.1.5', okSpawn)).toBe(true);
        expect(npmViewVersion('@gobing-ai/ts-cache', '0.1.5', missingSpawn)).toBe(false);
    });

    test('normalizes npm publish output', () => {
        const okSpawn = (() => ({ status: 0, stdout: 'published', stderr: '' })) as typeof spawnSync;
        const failedSpawn = (() => ({
            status: 1,
            stdout: 'notice',
            stderr: 'cannot publish over the previously published versions',
        })) as typeof spawnSync;

        expect(npmPublish('packages/cache', okSpawn)).toEqual({ ok: true, output: 'published' });
        expect(npmPublish('packages/cache', failedSpawn)).toEqual({
            ok: false,
            output: 'notice\ncannot publish over the previously published versions',
        });
    });

    test('detects npm immutable-version conflicts', () => {
        expect(isAlreadyPublishedError('You cannot publish over the previously published versions')).toBe(true);
        expect(isAlreadyPublishedError('E409 conflict')).toBe(true);
        expect(isAlreadyPublishedError('network timeout')).toBe(false);
    });
});

describe('workspace discovery', () => {
    test('discovers root and workspace manifests from package.json workspaces', async () => {
        const packages = await findWorkspacePackages();

        expect(packages.map((workspacePackage) => workspacePackage.name)).toContain('@gobing-ai/ts-libs');
        expect(packages.map((workspacePackage) => workspacePackage.name)).toContain('@gobing-ai/ts-utils');
        expect(packages.find((workspacePackage) => workspacePackage.name === '@gobing-ai/ts-infra')).toHaveProperty(
            'dependencies',
        );
    });
});

describe('sortPackagesByDependencyOrder', () => {
    test('detects internal dependency cycles', async () => {
        const packages = [
            pkg('@gobing-ai/ts-a', 'packages/a', { '@gobing-ai/ts-b': '^0.1.0' }),
            pkg('@gobing-ai/ts-b', 'packages/b', { '@gobing-ai/ts-a': '^0.1.0' }),
        ];

        await expect(sortPackagesByDependencyOrder(packages)).rejects.toThrow('internal package dependency cycle');
    });
});
