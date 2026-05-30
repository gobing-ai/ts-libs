import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../', import.meta.url));

export const releaseConfig = {
    packageNamePrefix: '@gobing-ai/ts-',
    aggregatePackageName: '@gobing-ai/ts-libs',
    tagVersionSeparator: '-v',
    publishWorkflow: 'publish.yml',
    releaseCommitType: 'chore',
    releaseCommitScope: 'release',
    releaseCommitSubject: (version: string) => `bump all packages to ${version}`,
    releaseTagMessage: (tag: string) => `release: ${tag}`,
    ghRunListLimit: 5,
} as const;

export const buildConfig = {
    distEntryExtension: '.js',
    nodeSmokePackages: [],
} as const;

export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
