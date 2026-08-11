import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { releaseConfig, repoRoot } from '../config';
import type { Spawn } from '../lib/command';
import type { WorkspacePackage } from '../lib/workspace';

// ── module seams ────────────────────────────────────────────────────────────
// The release commands discover the workspace and call npm through module
// imports. Mock both so tests run against temp fixtures with deterministic
// results — no real `npm view`/`npm publish` subprocess and no reads of the
// real workspace (beyond the read-only CHANGELOG/bun.lock existence probe).
let fixture: { root: string; packages: WorkspacePackage[] } = { root: '', packages: [] };
const fixtureRoots: string[] = [];
let npmAlreadyPublished = false;
let publishFailure = '';
let publishConflict = false;

mock.module('../lib/workspace', () => ({
    findWorkspacePackages: async () => fixture.packages,
}));

mock.module('../lib/release', () => ({
    createReleaseTag: (pkg: { name: string }, version: string) =>
        `${pkg.name}${releaseConfig.tagVersionSeparator}${version}`,
    createAggregateReleaseTag: (version: string) =>
        `${releaseConfig.aggregatePackageName}${releaseConfig.tagVersionSeparator}${version}`,
    branchPushArgs: (branch: string) => ['-c', 'push.followTags=false', 'push', '--no-follow-tags', 'origin', branch],
    tagPushArgs: (tag: string) => [
        '-c',
        'push.followTags=false',
        'push',
        'origin',
        `refs/tags/${tag}:refs/tags/${tag}`,
    ],
    sortPackagesByDependencyOrder: async (packages: WorkspacePackage[]) => packages.filter((pkg) => !pkg.private),
    selectPackagesForPublish: async (packages: WorkspacePackage[]) => packages,
    npmViewVersion: () => npmAlreadyPublished,
    npmPublish: () =>
        publishFailure !== '' ? { ok: false, output: publishFailure } : { ok: true, output: 'published' },
    isAlreadyPublishedError: () => publishConflict,
}));

import { bumpVersion, dropTags, ensurePublishWorkflowRun, publishPackages } from '../lib/release-commands';

const VERSION = '0.1.6';
const AGG_TAG = `${releaseConfig.aggregatePackageName}${releaseConfig.tagVersionSeparator}${VERSION}`;
const UTILS_TAG = `@gobing-ai/ts-utils${releaseConfig.tagVersionSeparator}${VERSION}`;
const RUNTIME_TAG = `@gobing-ai/ts-runtime${releaseConfig.tagVersionSeparator}${VERSION}`;

async function installFixture(workspaceRanges: boolean): Promise<void> {
    // Temp fixture lives INSIDE repoRoot so `${repoRoot}${pkg.dir}/package.json`
    // (publishWithResolvedRanges) resolves to the fixture, not the real workspace.
    const root = await mkdtemp(join(repoRoot, '.tmp-rel-test-'));
    const defs = [
        { name: '@gobing-ai/ts-utils', deps: {} },
        {
            name: '@gobing-ai/ts-runtime',
            deps: workspaceRanges ? { '@gobing-ai/ts-utils': 'workspace:*' } : {},
        },
    ];
    const packages: WorkspacePackage[] = [];
    for (const def of defs) {
        const dir = join(root.replace(repoRoot, ''), 'packages', def.name.split('-').pop() as string);
        const pkgDir = join(repoRoot, dir);
        await mkdir(pkgDir, { recursive: true });
        const manifest = { name: def.name, version: '0.1.5', private: false, dependencies: def.deps };
        await writeFile(join(pkgDir, 'package.json'), `${JSON.stringify(manifest, null, 4)}\n`);
        packages.push({
            path: join(pkgDir, 'package.json'),
            dir,
            name: def.name,
            version: '0.1.5',
            private: false,
            dependencies: def.deps,
        });
    }
    fixture = { root, packages };
    fixtureRoots.push(root);
}

afterAll(async () => {
    for (const root of fixtureRoots) {
        await rm(root, { recursive: true, force: true });
    }
});

beforeEach(() => {
    fixture = { root: '', packages: [] };
    npmAlreadyPublished = false;
    publishFailure = '';
    publishConflict = false;
});

// ── scripted spawn ──────────────────────────────────────────────────────────

interface SpawnRoute {
    match: (cmd: string, args: string[]) => boolean;
    stdout?: string;
    stderr?: string;
    status?: number;
}

function fakeSpawn(script: SpawnRoute[]): { spawn: Spawn; calls: string[] } {
    const calls: string[] = [];
    let step = 0;
    const spawn = ((cmd: string, args: string[]) => {
        calls.push([cmd, ...args].join(' '));
        const route = script[step];
        step += 1;
        if (route === undefined || !route.match(cmd, args)) {
            return {
                status: 1,
                stdout: '',
                stderr: `no spawn route: ${cmd} ${args.join(' ')}`,
                pid: 1,
                signal: null,
                output: [],
            };
        }
        return {
            status: route.status ?? 0,
            stdout: route.stdout ?? '',
            stderr: route.stderr ?? '',
            pid: 1,
            signal: null,
            output: [],
        };
    }) as Spawn;
    return { spawn, calls };
}

const git =
    (...args: string[]) =>
    (cmd: string, a: string[]) =>
        cmd === 'git' && a.join(' ') === args.join(' ');
const gh =
    (...args: string[]) =>
    (cmd: string, a: string[]) =>
        cmd === 'gh' && a.join(' ') === args.join(' ');

const PUSH_RUN = JSON.stringify([
    {
        databaseId: 12345,
        headBranch: AGG_TAG,
        event: 'push',
        url: `https://github.com/gobing-ai/ts-libs/actions/runs/12345`,
    },
]);
const DISPATCHED_RUN = JSON.stringify([
    {
        databaseId: 67890,
        headBranch: AGG_TAG,
        event: 'workflow_dispatch',
        url: `https://github.com/gobing-ai/ts-libs/actions/runs/67890`,
    },
]);
const EMPTY = '[]';

const noopSleep = async (): Promise<void> => {};

function listArgs(): string[] {
    return [
        'run',
        'list',
        '--workflow',
        releaseConfig.publishWorkflow,
        '--limit',
        String(releaseConfig.ghRunListLimit),
        '--json',
        'databaseId,headBranch,event,url',
    ];
}

function dispatchArgs(): string[] {
    return ['workflow', 'run', releaseConfig.publishWorkflow, '--ref', AGG_TAG];
}

function cleanGitSpawn(push = false): { spawn: Spawn; calls: string[] } {
    // Exact command order for the happy path: preflight (4), add+commit+tags (3),
    // then (push only) branch push, one tag push per tag, and the gh run lookup.
    const script: SpawnRoute[] = [
        { match: git('status', '--porcelain'), stdout: '' },
        { match: git('rev-parse', '--abbrev-ref', 'HEAD'), stdout: 'main' },
        { match: git('tag', '-l'), stdout: '' },
        { match: git('ls-remote', '--tags', 'origin'), stdout: '' },
        { match: (c, a) => c === 'git' && a[0] === 'add', stdout: '' },
        { match: (c, a) => c === 'git' && a[0] === 'commit', stdout: '' },
        // one annotated tag per package + the aggregate tag
        { match: (c, a) => c === 'git' && a[0] === 'tag' && a[1] === '-a', stdout: '' },
        { match: (c, a) => c === 'git' && a[0] === 'tag' && a[1] === '-a', stdout: '' },
        { match: (c, a) => c === 'git' && a[0] === 'tag' && a[1] === '-a', stdout: '' },
    ];
    if (push) {
        script.push(
            { match: (c, a) => c === 'git' && a.join(' ').includes('--no-follow-tags'), stdout: '' },
            { match: (c, a) => c === 'git' && a.join(' ').includes(`refs/tags/${UTILS_TAG}`), stdout: '' },
            { match: (c, a) => c === 'git' && a.join(' ').includes(`refs/tags/${RUNTIME_TAG}`), stdout: '' },
            { match: (c, a) => c === 'git' && a.join(' ').includes(`refs/tags/${AGG_TAG}`), stdout: '' },
            { match: gh(...listArgs()), stdout: PUSH_RUN },
        );
    }
    return fakeSpawn(script);
}

// ── ensurePublishWorkflowRun (R4, task 0510) ────────────────────────────────

describe('ensurePublishWorkflowRun (R4, task 0510)', () => {
    test('returns the push-triggered Publish run immediately when it is visible (no dispatch)', async () => {
        const { spawn, calls } = fakeSpawn([{ match: gh(...listArgs()), stdout: PUSH_RUN }]);
        const run = await ensurePublishWorkflowRun(AGG_TAG, spawn, noopSleep);
        expect(run.databaseId).toBe('12345');
        expect(run.url).toContain('runs/12345');
        expect(run.event).toBe('push');
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain('run list');
        expect(calls[0]).not.toContain('workflow run');
    });

    test('performs a bounded lookup, then exactly one dispatch, and confirms the dispatched run', async () => {
        const { spawn, calls } = fakeSpawn([
            { match: gh(...listArgs()), stdout: EMPTY },
            { match: gh(...listArgs()), stdout: EMPTY },
            { match: gh(...listArgs()), stdout: EMPTY },
            { match: gh(...dispatchArgs()), stdout: '' },
            { match: gh(...listArgs()), stdout: DISPATCHED_RUN },
        ]);
        const run = await ensurePublishWorkflowRun(AGG_TAG, spawn, noopSleep);
        expect(run.databaseId).toBe('67890');
        expect(run.event).toBe('workflow_dispatch');
        // Three lookups, one dispatch, one final lookup — exactly 5 commands.
        expect(calls).toHaveLength(5);
        const dispatchCalls = calls.filter((c) => c.includes('workflow run'));
        expect(dispatchCalls).toHaveLength(1);
        expect(dispatchCalls[0]).toContain('--ref');
        expect(dispatchCalls[0]).toContain(AGG_TAG);
    });

    test('throws when no run appears after the bounded lookup and one dispatch', async () => {
        const { spawn } = fakeSpawn([
            { match: gh(...listArgs()), stdout: EMPTY },
            { match: gh(...listArgs()), stdout: EMPTY },
            { match: gh(...listArgs()), stdout: EMPTY },
            { match: gh(...dispatchArgs()), stdout: '' },
            { match: gh(...listArgs()), stdout: EMPTY },
        ]);
        await expect(ensurePublishWorkflowRun(AGG_TAG, spawn, noopSleep)).rejects.toThrow(
            /No Publish workflow run found for aggregate tag/,
        );
    });

    test('throws on malformed gh run list JSON', async () => {
        const { spawn } = fakeSpawn([{ match: gh(...listArgs()), stdout: 'this is not json' }]);
        await expect(ensurePublishWorkflowRun(AGG_TAG, spawn, noopSleep)).rejects.toThrow(/malformed JSON/);
    });

    test('throws when gh fails instead of silently returning', async () => {
        const { spawn } = fakeSpawn([{ match: gh(...listArgs()), status: 1, stdout: '', stderr: 'gh: not logged in' }]);
        await expect(ensurePublishWorkflowRun(AGG_TAG, spawn, noopSleep)).rejects.toThrow(/gh run list failed/);
    });

    test('never invokes a tag-mutating command on any path', async () => {
        const { spawn, calls } = fakeSpawn([
            { match: gh(...listArgs()), stdout: EMPTY },
            { match: gh(...listArgs()), stdout: EMPTY },
            { match: gh(...listArgs()), stdout: EMPTY },
            { match: gh(...dispatchArgs()), stdout: '' },
            { match: gh(...listArgs()), stdout: DISPATCHED_RUN },
        ]);
        await ensurePublishWorkflowRun(AGG_TAG, spawn, noopSleep);
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
            expect(call.startsWith('git')).toBe(false);
            expect(call).not.toContain(':refs/tags/');
            expect(call).not.toContain('tag -d');
        }
        const { spawn: spawn2, calls: calls2 } = fakeSpawn([{ match: gh(...listArgs()), stdout: PUSH_RUN }]);
        await ensurePublishWorkflowRun(AGG_TAG, spawn2, noopSleep);
        expect(calls2).toHaveLength(1);
        expect(calls2[0].startsWith('git')).toBe(false);
    });
});

// ── bumpVersion ─────────────────────────────────────────────────────────────

describe('bumpVersion', () => {
    test('rejects an invalid semver version', async () => {
        await expect(bumpVersion('nope', { push: false })).rejects.toThrow('not a valid semver');
    });

    test('aborts on a dirty working tree before touching anything', async () => {
        await installFixture(false);
        const { spawn } = fakeSpawn([{ match: git('status', '--porcelain'), stdout: 'M package.json' }]);
        await expect(bumpVersion(VERSION, { push: false }, spawn)).rejects.toThrow('working tree is not clean');
    });

    test('aborts on a detached HEAD', async () => {
        await installFixture(false);
        const { spawn } = fakeSpawn([
            { match: git('status', '--porcelain'), stdout: '' },
            { match: git('rev-parse', '--abbrev-ref', 'HEAD'), stdout: 'HEAD' },
        ]);
        await expect(bumpVersion(VERSION, { push: false }, spawn)).rejects.toThrow('detached HEAD');
    });

    test('aborts when the release tags already exist locally', async () => {
        await installFixture(false);
        const { spawn } = fakeSpawn([
            { match: git('status', '--porcelain'), stdout: '' },
            { match: git('rev-parse', '--abbrev-ref', 'HEAD'), stdout: 'main' },
            { match: git('tag', '-l'), stdout: `${UTILS_TAG}\n` },
        ]);
        await expect(bumpVersion(VERSION, { push: false }, spawn)).rejects.toThrow('tags already exist locally');
    });

    test('aborts when the release tags already exist on origin', async () => {
        await installFixture(false);
        const { spawn } = fakeSpawn([
            { match: git('status', '--porcelain'), stdout: '' },
            { match: git('rev-parse', '--abbrev-ref', 'HEAD'), stdout: 'main' },
            { match: git('tag', '-l'), stdout: '' },
            { match: git('ls-remote', '--tags', 'origin'), stdout: `refs/tags/${AGG_TAG}\n` },
        ]);
        await expect(bumpVersion(VERSION, { push: false }, spawn)).rejects.toThrow('tags already exist on origin');
    });

    test('aborts when the version is already published on npm', async () => {
        await installFixture(false);
        npmAlreadyPublished = true;
        const { spawn } = fakeSpawn([
            { match: git('status', '--porcelain'), stdout: '' },
            { match: git('rev-parse', '--abbrev-ref', 'HEAD'), stdout: 'main' },
            { match: git('tag', '-l'), stdout: '' },
            { match: git('ls-remote', '--tags', 'origin'), stdout: '' },
        ]);
        await expect(bumpVersion(VERSION, { push: false }, spawn)).rejects.toThrow('already published on npm');
    });

    test('bumps manifests, commits, and tags locally without pushing when push=false', async () => {
        await installFixture(false);
        const { spawn, calls } = cleanGitSpawn(false);
        await bumpVersion(VERSION, { push: false }, spawn);

        // Manifests were bumped on disk.
        for (const pkg of fixture.packages) {
            const manifest = JSON.parse(await readFile(pkg.path, 'utf8'));
            expect(manifest.version).toBe(VERSION);
        }
        // Commit + one annotated tag per package + the aggregate tag.
        expect(calls.filter((c) => c.startsWith('git commit'))).toHaveLength(1);
        expect(calls.filter((c) => c.includes('tag -a'))).toHaveLength(3);
        expect(calls.some((c) => c.includes(AGG_TAG))).toBe(true);
        // No push, no gh.
        expect(calls.some((c) => c.includes('push'))).toBe(false);
        expect(calls.some((c) => c.startsWith('gh'))).toBe(false);
    });

    test('push path verifies the Publish run and reports it', async () => {
        await installFixture(false);
        const { spawn, calls } = cleanGitSpawn(true);
        await bumpVersion(VERSION, { push: true }, spawn);

        for (const pkg of fixture.packages) {
            const manifest = JSON.parse(await readFile(pkg.path, 'utf8'));
            expect(manifest.version).toBe(VERSION);
        }
        // Branch push first (--no-follow-tags), then one push per tag.
        expect(calls.some((c) => c.includes('--no-follow-tags') && c.includes('origin main'))).toBe(true);
        expect(calls.filter((c) => c.includes('refs/tags/'))).toHaveLength(3);
        expect(calls.some((c) => c.includes(`refs/tags/${AGG_TAG}:refs/tags/${AGG_TAG}`))).toBe(true);
        // Exactly one gh run-list lookup, no dispatch (push run was visible).
        const ghCalls = calls.filter((c) => c.startsWith('gh'));
        expect(ghCalls).toHaveLength(1);
        expect(ghCalls[0]).toContain('run list');
    });
});

// ── dropTags ────────────────────────────────────────────────────────────────

describe('dropTags', () => {
    test('rejects an invalid semver version', async () => {
        await expect(dropTags('nope', { remote: false })).rejects.toThrow('not a valid semver');
    });

    test('deletes local tags only when remote=false', async () => {
        await installFixture(false);
        const { spawn, calls } = fakeSpawn([
            { match: git('tag', '-l'), stdout: `${UTILS_TAG}\n${RUNTIME_TAG}\n${AGG_TAG}\n` },
            { match: (c, a) => c === 'git' && a[0] === 'tag' && a[1] === '-d', stdout: '' },
            { match: (c, a) => c === 'git' && a[0] === 'tag' && a[1] === '-d', stdout: '' },
            { match: (c, a) => c === 'git' && a[0] === 'tag' && a[1] === '-d', stdout: '' },
        ]);
        await dropTags(VERSION, { remote: false }, spawn);
        const deletions = calls.filter((c) => c.includes('tag -d'));
        expect(deletions).toHaveLength(3);
        expect(deletions.some((c) => c.includes(AGG_TAG))).toBe(true);
        // No remote deletions requested.
        expect(calls.some((c) => c.includes(':refs/tags/'))).toBe(false);
    });

    test('deletes local and remote tags when remote=true', async () => {
        await installFixture(false);
        // dropTags loops per tag: delete local, then (remote) push delete — interleaved.
        const { spawn, calls } = fakeSpawn([
            { match: git('tag', '-l'), stdout: `${UTILS_TAG}\n${RUNTIME_TAG}\n${AGG_TAG}\n` },
            { match: (c, a) => c === 'git' && a[0] === 'tag' && a[1] === '-d', stdout: '' },
            { match: (c, a) => c === 'git' && a[0] === 'push' && a[1] === 'origin', stdout: '' },
            { match: (c, a) => c === 'git' && a[0] === 'tag' && a[1] === '-d', stdout: '' },
            { match: (c, a) => c === 'git' && a[0] === 'push' && a[1] === 'origin', stdout: '' },
            { match: (c, a) => c === 'git' && a[0] === 'tag' && a[1] === '-d', stdout: '' },
            { match: (c, a) => c === 'git' && a[0] === 'push' && a[1] === 'origin', stdout: '' },
        ]);
        await dropTags(VERSION, { remote: true }, spawn);
        const remoteDeletions = calls.filter((c) => c.includes(':refs/tags/'));
        expect(remoteDeletions).toHaveLength(3);
        expect(remoteDeletions.some((c) => c.includes(`:refs/tags/${AGG_TAG}`))).toBe(true);
    });
});

// ── publishPackages ─────────────────────────────────────────────────────────

describe('publishPackages', () => {
    test('publishes every package, resolving workspace ranges without leaving writes behind', async () => {
        await installFixture(true);
        await publishPackages('tag', AGG_TAG.replace(/.*-v/, ''));

        // The real publish path restores the manifest in its finally block.
        for (const pkg of fixture.packages) {
            const raw = await readFile(pkg.path, 'utf8');
            expect(JSON.parse(raw).version).toBe('0.1.5');
            if (pkg.name === '@gobing-ai/ts-runtime') {
                expect(raw).toContain('workspace:*');
            }
        }
    });

    test('skips packages whose version is already on npm', async () => {
        await installFixture(false);
        npmAlreadyPublished = true;
        // Must not throw and must not attempt a publish (npmPublish is mocked to fail loudly).
        await publishPackages('tag', '0.1.5');
    });

    test('treats a lost publish race as a skip', async () => {
        await installFixture(false);
        publishFailure = 'EPUBLISHCONFLICT: cannot publish over';
        publishConflict = true;
        await publishPackages('tag', '0.1.5');
    });

    test('fails loudly when a publish fails for a non-conflict reason', async () => {
        await installFixture(false);
        publishFailure = 'npm error: registry unreachable';
        publishConflict = false;
        await expect(publishPackages('tag', '0.1.5')).rejects.toThrow('registry unreachable');
    });
});
