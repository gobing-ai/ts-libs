import { spawnSync } from 'node:child_process';
import { releaseConfig, repoRoot, SEMVER } from '../config';
import { runCommand, type Spawn } from './command';
import {
    branchPushArgs,
    createAggregateReleaseTag,
    createReleaseTag,
    isAlreadyPublishedError,
    npmPublish,
    npmViewVersion,
    selectPackagesForPublish,
    sortPackagesByDependencyOrder,
    tagPushArgs,
} from './release';
import { findWorkspacePackages } from './workspace';
import { assertNoWorkspaceRanges, type ManifestLike, substituteWorkspaceRanges } from './workspace-deps';

export interface BumpVersionOptions {
    push: boolean;
    findWorkspacePackages?: typeof findWorkspacePackages;
    npmViewVersion?: typeof npmViewVersion;
    log?: (message: string) => void;
}

/**
 * Publish a single package with its `workspace:` dependency ranges resolved to
 * concrete caret ranges. The on-disk manifest is rewritten just for the publish
 * (npm reads the manifest from disk) and restored afterwards, so the working
 * tree is never left mutated.
 *
 * Fail-closed: if any `workspace:` range survives substitution, the publish is
 * refused rather than shipping a broken manifest.
 */
async function publishWithResolvedRanges(
    dir: string,
    name: string,
    versions: Map<string, string>,
    npmPublishFn: typeof npmPublish = npmPublish,
    log: (message: string) => void = console.log,
) {
    const manifestPath = `${repoRoot}${dir}/package.json`;
    const original = await Bun.file(manifestPath).text();
    const parsed = JSON.parse(original) as ManifestLike;

    const { manifest, changed } = substituteWorkspaceRanges(parsed, versions);
    assertNoWorkspaceRanges(manifest, name);

    if (changed === 0) {
        return npmPublishFn(`${repoRoot}${dir}`);
    }

    await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
    try {
        log(`  resolved ${changed} workspace dependency range(s) for ${name}`);
        return npmPublishFn(`${repoRoot}${dir}`);
    } finally {
        await Bun.write(manifestPath, original);
    }
}

export interface DropTagsOptions {
    remote: boolean;
    findWorkspacePackages?: typeof findWorkspacePackages;
    log?: (message: string) => void;
}

export interface PublishPackagesDeps {
    findWorkspacePackages?: typeof findWorkspacePackages;
    selectPackagesForPublish?: typeof selectPackagesForPublish;
    sortPackagesByDependencyOrder?: typeof sortPackagesByDependencyOrder;
    npmViewVersion?: typeof npmViewVersion;
    npmPublish?: typeof npmPublish;
    isAlreadyPublishedError?: typeof isAlreadyPublishedError;
    log?: (message: string) => void;
}

export async function publishPackages(
    refType = process.env.GITHUB_REF_TYPE,
    refName = process.env.GITHUB_REF_NAME,
    deps: PublishPackagesDeps = {},
): Promise<void> {
    const findPkgs = deps.findWorkspacePackages ?? findWorkspacePackages;
    const selectPkgs = deps.selectPackagesForPublish ?? selectPackagesForPublish;
    const sortPkgs = deps.sortPackagesByDependencyOrder ?? sortPackagesByDependencyOrder;
    const checkNpm = deps.npmViewVersion ?? npmViewVersion;
    const pubNpm = deps.npmPublish ?? npmPublish;
    const isAlreadyPubErr = deps.isAlreadyPublishedError ?? isAlreadyPublishedError;
    const log = deps.log ?? console.log;

    const packages = await findPkgs();
    const versions = new Map(packages.map((pkg) => [pkg.name, pkg.version]));
    const selected = await selectPkgs(packages, refType, refName);
    const orderedSelected = await sortPkgs(selected);

    for (const pkg of orderedSelected) {
        if (checkNpm(pkg.name, pkg.version)) {
            log(`skip: ${pkg.name}@${pkg.version} already published`);
            continue;
        }

        log(`publish: ${pkg.name}@${pkg.version}`);
        const result = await publishWithResolvedRanges(pkg.dir, pkg.name, versions, pubNpm, log);
        if (!result.ok) {
            if (isAlreadyPubErr(result.output)) {
                log(`skip: ${pkg.name}@${pkg.version} already published (lost publish race)`);
                continue;
            }

            throw new Error(result.output);
        }

        log(result.output);
    }
}

export async function bumpVersion(
    version: string,
    options: BumpVersionOptions,
    spawn: Spawn = spawnSync,
): Promise<void> {
    if (!SEMVER.test(version)) {
        throw new Error(`"${version}" is not a valid semver version (expected e.g. 0.1.4).`);
    }

    const findPkgs = options.findWorkspacePackages ?? findWorkspacePackages;
    const checkNpm = options.npmViewVersion ?? npmViewVersion;
    const log = options.log ?? console.log;

    const packages = await findPkgs();
    const publishable = await sortPackagesByDependencyOrder(packages);
    const packageTags = publishable.map((pkg) => createReleaseTag(pkg, version));
    const aggregateTag = createAggregateReleaseTag(version);
    const tags = [...packageTags, aggregateTag];

    if (git(['status', '--porcelain'], spawn).stdout !== '') {
        throw new Error('working tree is not clean. Commit or stash changes before releasing.');
    }

    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], spawn).stdout;
    if (branch === 'HEAD') {
        throw new Error('detached HEAD — checkout a branch before releasing.');
    }

    const existingLocal = new Set(git(['tag', '-l'], spawn).stdout.split('\n').filter(Boolean));
    const localClash = tags.filter((tag) => existingLocal.has(tag));
    if (localClash.length > 0) {
        throw new Error(
            `tags already exist locally: ${localClash.join(', ')}. Run "bun run drop-tags ${version}" first.`,
        );
    }

    const remoteRefs = git(['ls-remote', '--tags', 'origin'], spawn).stdout;
    const remoteClash = tags.filter((tag) => remoteRefs.includes(`refs/tags/${tag}`));
    if (remoteClash.length > 0) {
        throw new Error(
            `tags already exist on origin: ${remoteClash.join(', ')}. Run "bun run drop-tags ${version} --remote" first.`,
        );
    }

    const published = publishable.filter((pkg) => checkNpm(pkg.name, version));
    if (published.length > 0) {
        throw new Error(
            `already published on npm at ${version}: ${published.map((pkg) => pkg.name).join(', ')}. Use a new version.`,
        );
    }

    for (const pkg of packages) {
        const manifest = await Bun.file(pkg.path).json();
        const previous = manifest.version;
        manifest.version = version;
        await Bun.write(pkg.path, `${JSON.stringify(manifest, null, 4)}\n`);
        log(`  ${manifest.name}: ${previous} -> ${version}`);
    }
    log(`\nBumped ${packages.length} manifests to ${version}.`);

    const manifestPaths = packages.map((pkg) => (pkg.dir === '.' ? 'package.json' : `${pkg.dir}/package.json`));
    const optional = ['CHANGELOG.md', 'bun.lock'].filter((path) => Bun.file(`${repoRoot}${path}`).size > 0);
    mustGit(['add', ...manifestPaths, ...optional], 'git add', spawn);

    const commitMessage = `${releaseConfig.releaseCommitType}(${releaseConfig.releaseCommitScope}): ${releaseConfig.releaseCommitSubject(version)}`;
    mustGit(['commit', '-m', commitMessage], 'git commit', spawn);
    log(`Committed: ${commitMessage}`);

    for (const tag of tags) {
        mustGit(['tag', '-a', tag, '-m', releaseConfig.releaseTagMessage(tag)], `git tag ${tag}`, spawn);
        log(`  tagged ${tag}`);
    }

    if (!options.push) {
        log('\nDone (local). Review, then push to release:');
        log(`  git push origin ${branch}`);
        log('  git push origin --tags');
        log('Or re-run with --push next time to do this automatically.');
        return;
    }

    log('\nPushing branch (tags excluded)...');
    mustGit(branchPushArgs(branch), `git push origin ${branch}`, spawn);

    for (const tag of packageTags) {
        log(`Pushing tag ${tag}...`);
        mustGit(tagPushArgs(tag), `git push origin ${tag}`, spawn);
    }
    log(`Pushing release trigger tag ${aggregateTag}...`);
    mustGit(tagPushArgs(aggregateTag), `git push origin ${aggregateTag}`, spawn);

    // R4 (task 0510): prove the aggregate tag created a Publish run before returning.
    // Bounded push-run lookup; a missed push event is recovered with exactly one
    // workflow_dispatch at the same immutable tag ref — never tag deletion/re-push.
    const publishRun = await ensurePublishWorkflowRun(aggregateTag, spawn, (ms) => Bun.sleep(ms), log);
    log(`\nReleased ${version}. Publish workflow run ${publishRun.databaseId}: ${publishRun.url}`);
}

/**
 * Verify that a Publish workflow run exists for the aggregate release tag before
 * returning (R4, task 0510). Performs at most `PUBLISH_RUN_LOOKUP_ATTEMPTS`
 * `gh run list` lookups at a fixed `PUBLISH_RUN_LOOKUP_INTERVAL_MS` interval,
 * matching `headBranch === aggregateTag` with event `push` or `workflow_dispatch`.
 * If no matching push run appears, dispatches `publish.yml` exactly once at the
 * aggregate tag ref through its existing `workflow_dispatch` trigger, then performs
 * one final lookup for the dispatched run. Returns the run's database ID and URL;
 * throws when `gh` fails, output is malformed, or no run appears on either path.
 * Never deletes, moves, or re-pushes a tag — the workflow is idempotent and the
 * release tag is immutable, so recovery is a dispatch, not a tag mutation.
 * `spawn` / `sleep` are injectable so tests can script deterministic command results.
 */
export async function ensurePublishWorkflowRun(
    aggregateTag: string,
    spawn: Spawn = spawnSync,
    sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
    log: (message: string) => void = console.log,
): Promise<PublishRunInfo> {
    const listRuns = (): PublishRunInfo | undefined => {
        const result = runCommand(
            'gh',
            [
                'run',
                'list',
                '--workflow',
                releaseConfig.publishWorkflow,
                '--limit',
                String(releaseConfig.ghRunListLimit),
                '--json',
                'databaseId,headBranch,event,url',
            ],
            { cwd: repoRoot },
            spawn,
        );
        if (!result.ok) {
            throw new Error(`gh run list failed:\n${result.stderr || result.stdout}`);
        }
        return findPublishRunForTag(result.stdout, aggregateTag);
    };

    for (let attempt = 1; attempt <= PUBLISH_RUN_LOOKUP_ATTEMPTS; attempt++) {
        const run = listRuns();
        if (run !== undefined) {
            log(`Publish workflow run ${run.databaseId} (${run.event}) for ${aggregateTag}: ${run.url}`);
            return run;
        }
        if (attempt < PUBLISH_RUN_LOOKUP_ATTEMPTS) {
            await sleep(PUBLISH_RUN_LOOKUP_INTERVAL_MS);
        }
    }

    log(
        `No push-triggered Publish run for ${aggregateTag} after ${PUBLISH_RUN_LOOKUP_ATTEMPTS} lookups; ` +
            `dispatching ${releaseConfig.publishWorkflow} at ref ${aggregateTag}...`,
    );
    const dispatch = runCommand(
        'gh',
        ['workflow', 'run', releaseConfig.publishWorkflow, '--ref', aggregateTag],
        { cwd: repoRoot },
        spawn,
    );
    if (!dispatch.ok) {
        throw new Error(
            `gh workflow run ${releaseConfig.publishWorkflow} --ref ${aggregateTag} failed:\n${dispatch.stderr || dispatch.stdout}`,
        );
    }

    const dispatched = listRuns();
    if (dispatched === undefined) {
        throw new Error(
            `No Publish workflow run found for aggregate tag ${aggregateTag} after workflow_dispatch. ` +
                `Check the Actions tab (${releaseConfig.publishWorkflow}) — the run may still be queued. ` +
                'Tags were not mutated; re-inspect with `gh run list --workflow=publish.yml` or re-run bump-ver.',
        );
    }
    log(`Dispatched Publish run ${dispatched.databaseId} (${dispatched.event}): ${dispatched.url}`);
    return dispatched;
}

/** Matched Publish run identity reported back to the caller. */
export interface PublishRunInfo {
    databaseId: string;
    url: string;
    event: string;
}

const PUBLISH_RUN_LOOKUP_ATTEMPTS = 3;
const PUBLISH_RUN_LOOKUP_INTERVAL_MS = 5000;

/**
 * Parse `gh run list --json databaseId,headBranch,event,url` output for a run whose
 * head branch equals the aggregate tag and whose event is `push` or
 * `workflow_dispatch`. Throws on malformed or non-array output; returns `undefined`
 * when no run matches (a bounded no-match, distinct from a `gh` failure).
 */
function findPublishRunForTag(stdout: string, aggregateTag: string): PublishRunInfo | undefined {
    let runs: unknown;
    try {
        runs = JSON.parse(stdout);
    } catch {
        throw new Error(`gh run list returned malformed JSON: ${stdout.slice(0, 200)}`);
    }
    if (!Array.isArray(runs)) {
        throw new Error(`gh run list returned an unexpected shape (expected an array): ${String(runs).slice(0, 200)}`);
    }
    for (const entry of runs) {
        const headBranch = (entry as { headBranch?: unknown }).headBranch;
        const event = (entry as { event?: unknown }).event;
        if (typeof headBranch !== 'string' || typeof event !== 'string') continue;
        if (headBranch !== aggregateTag || (event !== 'push' && event !== 'workflow_dispatch')) continue;
        return {
            databaseId: String((entry as { databaseId?: unknown }).databaseId ?? ''),
            url: String((entry as { url?: unknown }).url ?? ''),
            event,
        };
    }
    return undefined;
}

export async function dropTags(version: string, options: DropTagsOptions, spawn: Spawn = spawnSync): Promise<void> {
    if (!SEMVER.test(version)) {
        throw new Error(`"${version}" is not a valid semver version (expected e.g. 0.1.2).`);
    }

    const findPkgs = options.findWorkspacePackages ?? findWorkspacePackages;
    const log = options.log ?? console.log;

    const packages = await findPkgs();
    const publishable = packages.filter((pkg) => !pkg.private);
    const tags = [...publishable.map((pkg) => createReleaseTag(pkg, version)), createAggregateReleaseTag(version)];
    const existingLocal = new Set(git(['tag', '-l'], spawn).stdout.split('\n').filter(Boolean));

    let deletedLocal = 0;
    let deletedRemote = 0;

    for (const tag of tags) {
        if (existingLocal.has(tag)) {
            const result = git(['tag', '-d', tag], spawn);
            log(result.ok ? `  local  deleted ${tag}` : `  local  failed ${tag}: ${result.stderr}`);
            if (result.ok) deletedLocal++;
        } else {
            log(`  local  not present ${tag}`);
        }

        if (options.remote) {
            const result = git(['push', 'origin', `:refs/tags/${tag}`], spawn);
            log(result.ok ? `  remote deleted ${tag}` : `  remote failed ${tag}: ${result.stderr}`);
            if (result.ok) deletedRemote++;
        }
    }

    log(
        `\nDeleted ${deletedLocal} local tag(s)${options.remote ? `, ${deletedRemote} remote tag(s)` : ''} for ${version}.`,
    );
    if (!options.remote) {
        log('Local only. Re-run with --remote to also delete the tags on origin.');
    }
}

function git(args: string[], spawn: Spawn = spawnSync) {
    return runCommand('git', args, { cwd: repoRoot }, spawn);
}

function mustGit(args: string[], label: string, spawn: Spawn = spawnSync): void {
    const result = git(args, spawn);
    if (!result.ok) {
        throw new Error(`\n${label} failed:\n${result.stderr || result.stdout}`);
    }
}
