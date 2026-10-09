import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { releaseConfig, repoRoot } from '../config';
import type { Spawn } from '../lib/command';
import type { WorkspacePackage } from '../lib/workspace';

// ── test seams ──────────────────────────────────────────────────────────────
let fixture: { root: string; packages: WorkspacePackage[] } = { root: '', packages: [] };
const fixtureRoots: string[] = [];
let npmAlreadyPublished = false;
let npmPackageMissing = false;
let publishFailure = '';
let publishConflict = false;
let publishCalls = 0;

const noopLog = () => {};

function fixtureDeps() {
    return {
        findWorkspacePackages: async () => fixture.packages,
        npmViewVersion: () => npmAlreadyPublished,
        npmViewPackage: () => !npmPackageMissing,
        npmPublish: () => {
            publishCalls += 1;
            return publishFailure !== '' ? { ok: false, output: publishFailure } : { ok: true, output: 'published' };
        },
        isAlreadyPublishedError: () => publishConflict,
        log: noopLog,
    };
}

import {
    bumpVersion,
    defaultRegenerateLockfile,
    dropTags,
    ensurePublishWorkflowRun,
    publishPackages,
    verifyPublish,
} from '../lib/release-commands';

const VERSION = '0.1.6';
const AGG_TAG = `${releaseConfig.aggregatePackageName}${releaseConfig.tagVersionSeparator}${VERSION}`;
const UTILS_TAG = `@gobing-ai/ts-utils${releaseConfig.tagVersionSeparator}${VERSION}`;
const RUNTIME_TAG = `@gobing-ai/ts-runtime${releaseConfig.tagVersionSeparator}${VERSION}`;

async function installFixture(workspaceRanges: boolean): Promise<void> {
    // Temp fixture lives INSIDE repoRoot so `${repoRoot}${pkg.dir}/package.json`
    // (publishWithResolvedRanges) resolves to the fixture, not the real workspace.
    const root = await mkdtemp(join(repoRoot, '.tmp-rel-test-'));
    const rootDir = root.replace(repoRoot, '');
    const rootPkgPath = join(root, 'package.json');
    await writeFile(
        rootPkgPath,
        `${JSON.stringify({ name: releaseConfig.aggregatePackageName, version: '0.1.5', private: true }, null, 4)}\n`,
    );
    const packages: WorkspacePackage[] = [
        {
            path: rootPkgPath,
            dir: rootDir,
            name: releaseConfig.aggregatePackageName,
            version: '0.1.5',
            private: true,
            dependencies: {},
        },
    ];
    const defs = [
        { name: '@gobing-ai/ts-utils', deps: {} },
        {
            name: '@gobing-ai/ts-runtime',
            deps: workspaceRanges ? { '@gobing-ai/ts-utils': 'workspace:*' } : {},
        },
    ];
    for (const def of defs) {
        const dir = join(rootDir, 'packages', def.name.split('-').pop() as string);
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
    npmPackageMissing = false;
    publishFailure = '';
    publishConflict = false;
    publishCalls = 0;
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
            // Tag pushes follow the canonical dependency order (name order here —
            // the fixture's runtime has no workspace deps), aggregate tag last.
            { match: (c, a) => c === 'git' && a.join(' ').includes(`refs/tags/${RUNTIME_TAG}`), stdout: '' },
            { match: (c, a) => c === 'git' && a.join(' ').includes(`refs/tags/${UTILS_TAG}`), stdout: '' },
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
        const run = await ensurePublishWorkflowRun(AGG_TAG, spawn, noopSleep, noopLog);
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
        const run = await ensurePublishWorkflowRun(AGG_TAG, spawn, noopSleep, noopLog);
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
        await expect(ensurePublishWorkflowRun(AGG_TAG, spawn, noopSleep, noopLog)).rejects.toThrow(
            /No Publish workflow run found for aggregate tag/,
        );
    });

    test('throws on malformed gh run list JSON', async () => {
        const { spawn } = fakeSpawn([{ match: gh(...listArgs()), stdout: 'this is not json' }]);
        await expect(ensurePublishWorkflowRun(AGG_TAG, spawn, noopSleep, noopLog)).rejects.toThrow(/malformed JSON/);
    });

    test('throws when gh fails instead of silently returning', async () => {
        const { spawn } = fakeSpawn([{ match: gh(...listArgs()), status: 1, stdout: '', stderr: 'gh: not logged in' }]);
        await expect(ensurePublishWorkflowRun(AGG_TAG, spawn, noopSleep, noopLog)).rejects.toThrow(
            /gh run list failed/,
        );
    });

    test('never invokes a tag-mutating command on any path', async () => {
        const { spawn, calls } = fakeSpawn([
            { match: gh(...listArgs()), stdout: EMPTY },
            { match: gh(...listArgs()), stdout: EMPTY },
            { match: gh(...listArgs()), stdout: EMPTY },
            { match: gh(...dispatchArgs()), stdout: '' },
            { match: gh(...listArgs()), stdout: DISPATCHED_RUN },
        ]);
        await ensurePublishWorkflowRun(AGG_TAG, spawn, noopSleep, noopLog);
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
            expect(call.startsWith('git')).toBe(false);
            expect(call).not.toContain(':refs/tags/');
            expect(call).not.toContain('tag -d');
        }
        const { spawn: spawn2, calls: calls2 } = fakeSpawn([{ match: gh(...listArgs()), stdout: PUSH_RUN }]);
        await ensurePublishWorkflowRun(AGG_TAG, spawn2, noopSleep, noopLog);
        expect(calls2).toHaveLength(1);
        expect(calls2[0].startsWith('git')).toBe(false);
    });
});

// ── verifyPublish (R2, R3, task 1143) ──────────────────────────────────────

describe('verifyPublish (R2, R3, task 1143)', () => {
    test('reports an existing run, prints id and URL, and gives exit 0 without dispatching (R4b)', async () => {
        const { spawn, calls } = fakeSpawn([{ match: gh(...listArgs()), stdout: PUSH_RUN }]);
        const logs: string[] = [];
        const exitCode = await verifyPublish(AGG_TAG, {
            spawn,
            sleep: noopSleep,
            log: (msg) => logs.push(msg),
            errorLog: noopLog,
        });
        expect(exitCode).toBe(0);
        expect(logs.some((l) => l.includes('12345') && l.includes('runs/12345'))).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain('run list');
        expect(calls.some((c) => c.includes('workflow run'))).toBe(false);
    });

    test('fails loudly with exit 1, prints recovery text, and makes zero dispatches when no run exists (R4c)', async () => {
        const { spawn, calls } = fakeSpawn([
            { match: gh(...listArgs()), stdout: EMPTY },
            { match: gh(...listArgs()), stdout: EMPTY },
            { match: gh(...listArgs()), stdout: EMPTY },
        ]);
        const errors: string[] = [];
        const exitCode = await verifyPublish(AGG_TAG, {
            spawn,
            sleep: noopSleep,
            log: noopLog,
            errorLog: (msg) => errors.push(msg),
        });
        expect(exitCode).toBe(1);
        const errorOutput = errors.join('\n');
        expect(errorOutput).toContain(AGG_TAG);
        expect(errorOutput).toContain('--dispatch');
        expect(errorOutput).toContain(`verify-publish ${AGG_TAG} --dispatch`);
        expect(calls.some((c) => c.includes('workflow run'))).toBe(false);
    });

    test('--dispatch performs exactly one workflow dispatch when no run exists (R4d)', async () => {
        const { spawn, calls } = fakeSpawn([
            { match: gh(...listArgs()), stdout: EMPTY },
            { match: gh(...listArgs()), stdout: EMPTY },
            { match: gh(...listArgs()), stdout: EMPTY },
            { match: gh(...dispatchArgs()), stdout: '' },
            { match: gh(...listArgs()), stdout: DISPATCHED_RUN },
        ]);
        const logs: string[] = [];
        const exitCode = await verifyPublish(AGG_TAG, {
            dispatch: true,
            spawn,
            sleep: noopSleep,
            log: (msg) => logs.push(msg),
            errorLog: noopLog,
        });
        expect(exitCode).toBe(0);
        expect(logs.some((l) => l.includes('67890'))).toBe(true);
        const dispatchCalls = calls.filter((c) => c.includes('workflow run'));
        expect(dispatchCalls).toHaveLength(1);
        expect(dispatchCalls[0]).toContain('--ref');
        expect(dispatchCalls[0]).toContain(AGG_TAG);
    });

    test('--dispatch gives exit 1 when no run appears after dispatch', async () => {
        const { spawn, calls } = fakeSpawn([
            { match: gh(...listArgs()), stdout: EMPTY },
            { match: gh(...listArgs()), stdout: EMPTY },
            { match: gh(...listArgs()), stdout: EMPTY },
            { match: gh(...dispatchArgs()), stdout: '' },
            { match: gh(...listArgs()), stdout: EMPTY },
        ]);
        const errors: string[] = [];
        const exitCode = await verifyPublish(AGG_TAG, {
            dispatch: true,
            spawn,
            sleep: noopSleep,
            log: noopLog,
            errorLog: (msg) => errors.push(msg),
        });
        expect(exitCode).toBe(1);
        expect(errors.join('\n')).toContain('No Publish workflow run found for aggregate tag');
        const dispatchCalls = calls.filter((c) => c.includes('workflow run'));
        expect(dispatchCalls).toHaveLength(1);
    });

    test('surfaces gh run list failure as an error, never treating it as a missing run', async () => {
        const { spawn } = fakeSpawn([{ match: gh(...listArgs()), status: 1, stdout: '', stderr: 'gh: not logged in' }]);
        await expect(
            verifyPublish(AGG_TAG, {
                spawn,
                sleep: noopSleep,
                log: noopLog,
                errorLog: noopLog,
            }),
        ).rejects.toThrow(/gh run list failed/);
    });
});

// ── bumpVersion ─────────────────────────────────────────────────────────────

function bumpOpts(push = false) {
    return {
        push,
        findWorkspacePackages: async () => fixture.packages,
        npmViewVersion: () => npmAlreadyPublished,
        // The fake spawn has no `bun install` route; the lockfile regenerator
        // is a real subprocess in production but a no-op under test.
        regenerateLockfile: () => {},
        log: noopLog,
    };
}

function dropOpts(remote = false) {
    return {
        remote,
        findWorkspacePackages: async () => fixture.packages,
        log: noopLog,
    };
}

// ── bumpVersion ─────────────────────────────────────────────────────────────

describe('bumpVersion', () => {
    test('rejects an invalid semver version', async () => {
        await expect(bumpVersion('nope', bumpOpts(false))).rejects.toThrow('not a valid semver');
    });

    test('aborts on a dirty working tree before touching anything', async () => {
        await installFixture(false);
        const { spawn } = fakeSpawn([{ match: git('status', '--porcelain'), stdout: 'M package.json' }]);
        await expect(bumpVersion(VERSION, bumpOpts(false), spawn)).rejects.toThrow('working tree is not clean');
    });

    test('aborts on a detached HEAD', async () => {
        await installFixture(false);
        const { spawn } = fakeSpawn([
            { match: git('status', '--porcelain'), stdout: '' },
            { match: git('rev-parse', '--abbrev-ref', 'HEAD'), stdout: 'HEAD' },
        ]);
        await expect(bumpVersion(VERSION, bumpOpts(false), spawn)).rejects.toThrow('detached HEAD');
    });

    test('aborts when the release tags already exist locally', async () => {
        await installFixture(false);
        const { spawn } = fakeSpawn([
            { match: git('status', '--porcelain'), stdout: '' },
            { match: git('rev-parse', '--abbrev-ref', 'HEAD'), stdout: 'main' },
            { match: git('tag', '-l'), stdout: `${UTILS_TAG}\n` },
        ]);
        await expect(bumpVersion(VERSION, bumpOpts(false), spawn)).rejects.toThrow('tags already exist locally');
    });

    test('aborts when the release tags already exist on origin', async () => {
        await installFixture(false);
        const { spawn } = fakeSpawn([
            { match: git('status', '--porcelain'), stdout: '' },
            { match: git('rev-parse', '--abbrev-ref', 'HEAD'), stdout: 'main' },
            { match: git('tag', '-l'), stdout: '' },
            { match: git('ls-remote', '--tags', 'origin'), stdout: `refs/tags/${AGG_TAG}\n` },
        ]);
        await expect(bumpVersion(VERSION, bumpOpts(false), spawn)).rejects.toThrow('tags already exist on origin');
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
        await expect(bumpVersion(VERSION, bumpOpts(false), spawn)).rejects.toThrow('already published on npm');
    });

    test('bumps manifests, commits, and tags locally without pushing when push=false', async () => {
        await installFixture(false);
        const { spawn, calls } = cleanGitSpawn(false);
        await bumpVersion(VERSION, bumpOpts(false), spawn);

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

    test('local-mode hint lists per-tag refspecs, states three-tag limit, and contains no --tags (R4a)', async () => {
        await installFixture(false);
        const logs: string[] = [];
        const { spawn } = cleanGitSpawn(false);
        await bumpVersion(VERSION, { ...bumpOpts(false), log: (msg) => logs.push(msg) }, spawn);

        const output = logs.join('\n');
        expect(output).not.toContain('--tags');
        expect(output).toContain('git push --no-follow-tags origin main');
        expect(output).not.toContain('git push origin main');
        expect(output).toContain(
            `git -c push.followTags=false push origin refs/tags/${RUNTIME_TAG}:refs/tags/${RUNTIME_TAG}`,
        );
        expect(output).toContain(
            `git -c push.followTags=false push origin refs/tags/${UTILS_TAG}:refs/tags/${UTILS_TAG}`,
        );
        expect(output).toContain(`git -c push.followTags=false push origin refs/tags/${AGG_TAG}:refs/tags/${AGG_TAG}`);
        // No printed push may omit the guard: an unguarded tag push follows every other annotated
        // tag on the commit, which is the 13-tag push GitHub ignores silently.
        for (const line of logs.filter((l) => l.trimStart().startsWith('git ') && l.includes('push'))) {
            expect(line.includes('--no-follow-tags') || line.includes('-c push.followTags=false')).toBe(true);
        }
        const utilsIdx = logs.findIndex((l) => l.includes(UTILS_TAG));
        const aggIdx = logs.findIndex((l) => l.includes(AGG_TAG));
        expect(aggIdx).toBeGreaterThan(utilsIdx);
        expect(output).toContain(`bun scripts/builder.ts verify-publish ${AGG_TAG}`);
        expect(output).toMatch(/three tags/i);
    });

    test('push path verifies the Publish run and reports it', async () => {
        await installFixture(false);
        const { spawn, calls } = cleanGitSpawn(true);
        await bumpVersion(VERSION, bumpOpts(true), spawn);

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

    test('syncs HISTORY_IMPORT_SCHEMA_VERSION and its pinned hash with the bump', async () => {
        const root = await mkdtemp(join(repoRoot, '.tmp-rel-test-'));
        fixtureRoots.push(root);
        const pkgDir = join(root.replace(repoRoot, ''), 'packages', 'llm-jsonl-importer');
        const pkgAbs = join(repoRoot, pkgDir);
        await mkdir(join(pkgAbs, 'src'), { recursive: true });
        await mkdir(join(pkgAbs, 'tests'), { recursive: true });
        const HASH = 'a'.repeat(64);
        await writeFile(
            join(pkgAbs, 'src', 'schema-sql.ts'),
            "export const HISTORY_IMPORT_SCHEMA_VERSION = '0.1.5';\nexport const HISTORY_IMPORT_SCHEMA_SQL = 'create table x;';\n",
        );
        await writeFile(
            join(pkgAbs, 'tests', 'schema-version.test.ts'),
            `const KNOWN_SCHEMA_HASHES = {\n    '0.1.5': '${HASH}',\n};\n`,
        );
        const manifestPath = join(pkgAbs, 'package.json');
        await writeFile(
            manifestPath,
            `${JSON.stringify({ name: '@gobing-ai/ts-llm-jsonl-importer', version: '0.1.5', private: false }, null, 4)}\n`,
        );
        fixture = {
            root,
            packages: [
                {
                    path: manifestPath,
                    dir: pkgDir,
                    name: '@gobing-ai/ts-llm-jsonl-importer',
                    version: '0.1.5',
                    private: false,
                    dependencies: {},
                },
            ],
        };

        const { spawn } = cleanGitSpawn(false);
        await bumpVersion(VERSION, bumpOpts(false), spawn);

        expect(await readFile(join(pkgAbs, 'src', 'schema-sql.ts'), 'utf8')).toContain(
            `HISTORY_IMPORT_SCHEMA_VERSION = '${VERSION}'`,
        );
        expect(await readFile(join(pkgAbs, 'tests', 'schema-version.test.ts'), 'utf8')).toContain(
            `'${VERSION}': '${HASH}'`,
        );
    });
});

// ── defaultRegenerateLockfile ───────────────────────────────────────────────

describe('defaultRegenerateLockfile', () => {
    test('runs `bun install --lockfile-only` and is silent on success', () => {
        const calls: string[] = [];
        const spawn = ((cmd: string, args: string[]) => {
            calls.push([cmd, ...args].join(' '));
            return { status: 0, stdout: '', stderr: '', pid: 1, signal: null, output: [] };
        }) as Spawn;
        expect(() => defaultRegenerateLockfile(spawn)).not.toThrow();
        expect(calls).toEqual([`bun install --lockfile-only`]);
    });

    test('throws loudly when bun install fails, surfacing stderr', () => {
        const spawn = (() => ({
            status: 1,
            stdout: '',
            stderr: 'resolution failed',
            pid: 1,
            signal: null,
            output: [],
        })) as Spawn;
        expect(() => defaultRegenerateLockfile(spawn)).toThrow('bun install --lockfile-only failed');
        expect(() => defaultRegenerateLockfile(spawn)).toThrow('resolution failed');
    });
});

// ── dropTags ────────────────────────────────────────────────────────────────

describe('dropTags', () => {
    test('rejects an invalid semver version', async () => {
        await expect(dropTags('nope', dropOpts(false))).rejects.toThrow('not a valid semver');
    });

    test('deletes local tags only when remote=false', async () => {
        await installFixture(false);
        const { spawn, calls } = fakeSpawn([
            { match: git('tag', '-l'), stdout: `${UTILS_TAG}\n${RUNTIME_TAG}\n${AGG_TAG}\n` },
            { match: (c, a) => c === 'git' && a[0] === 'tag' && a[1] === '-d', stdout: '' },
            { match: (c, a) => c === 'git' && a[0] === 'tag' && a[1] === '-d', stdout: '' },
            { match: (c, a) => c === 'git' && a[0] === 'tag' && a[1] === '-d', stdout: '' },
        ]);
        await dropTags(VERSION, dropOpts(false), spawn);
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
        await dropTags(VERSION, dropOpts(true), spawn);
        const remoteDeletions = calls.filter((c) => c.includes(':refs/tags/'));
        expect(remoteDeletions).toHaveLength(3);
        expect(remoteDeletions.some((c) => c.includes(`:refs/tags/${AGG_TAG}`))).toBe(true);
    });
});

// ── publishPackages ─────────────────────────────────────────────────────────

describe('publishPackages', () => {
    test('publishes every package, resolving workspace ranges without leaving writes behind', async () => {
        await installFixture(true);
        await publishPackages('tag', `@gobing-ai/ts-libs-v0.1.5`, fixtureDeps());

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
        await publishPackages('tag', `@gobing-ai/ts-libs-v0.1.5`, fixtureDeps());
    });

    test('treats a lost publish race as a skip', async () => {
        await installFixture(false);
        publishFailure = 'EPUBLISHCONFLICT: cannot publish over';
        publishConflict = true;
        await publishPackages('tag', `@gobing-ai/ts-libs-v0.1.5`, fixtureDeps());
    });

    test('fails loudly when a publish fails for a non-conflict reason', async () => {
        await installFixture(false);
        publishFailure = 'npm error: registry unreachable';
        publishConflict = false;
        await expect(publishPackages('tag', `@gobing-ai/ts-libs-v0.1.5`, fixtureDeps())).rejects.toThrow(
            'registry unreachable',
        );
    });

    // A package npm has never seen has no Trusted Publisher to authenticate
    // against, so the OIDC publish fails with ENEEDAUTH. Aborting up front keeps
    // that failure from stranding every package ordered after it.
    test('aborts before publishing anything when a package is not on npm yet', async () => {
        await installFixture(false);
        npmPackageMissing = true;

        const message = await publishPackages('tag', `@gobing-ai/ts-libs-v0.1.5`, fixtureDeps()).then(
            () => '',
            (error: Error) => error.message,
        );

        // Order-independent: the message lists every unpublished package.
        expect(message).toMatch(/^not on npm yet: /);
        expect(message).toContain('@gobing-ai/ts-utils');
        expect(message).toContain('@gobing-ai/ts-runtime');
        expect(publishCalls).toBe(0);
    });

    test('names the bootstrap path when only one package is unpublished', async () => {
        await installFixture(false);
        const missing = '@gobing-ai/ts-runtime';
        const deps = fixtureDeps();
        await expect(
            publishPackages('tag', `@gobing-ai/ts-libs-v0.1.5`, {
                ...deps,
                npmViewPackage: (name: string) => name !== missing,
            }),
        ).rejects.toThrow(/--bootstrap <name>/);
        expect(publishCalls).toBe(0);
    });

    test('--bootstrap publishes a package npm has never seen, resolving workspace ranges', async () => {
        await installFixture(true);
        npmPackageMissing = true;

        await publishPackages(undefined, undefined, fixtureDeps(), { bootstrap: '@gobing-ai/ts-runtime' });

        expect(publishCalls).toBe(1);
        const runtime = fixture.packages.find((pkg) => pkg.name === '@gobing-ai/ts-runtime');
        expect(await readFile(runtime?.path as string, 'utf8')).toContain('workspace:*');
    });

    test('--bootstrap rejects a name that is not a publishable workspace package', async () => {
        await installFixture(false);
        const deps = fixtureDeps();

        await expect(
            publishPackages(undefined, undefined, deps, { bootstrap: '@gobing-ai/ts-missing' }),
        ).rejects.toThrow('no workspace package has that name');
        await expect(
            publishPackages(undefined, undefined, deps, { bootstrap: releaseConfig.aggregatePackageName }),
        ).rejects.toThrow('private package');
        expect(publishCalls).toBe(0);
    });
});
