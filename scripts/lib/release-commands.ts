import { releaseConfig, repoRoot, SEMVER } from '../config';
import { runCommand } from './command';
import {
    createReleaseTag,
    isAlreadyPublishedError,
    npmPublish,
    npmViewVersion,
    selectPackagesForPublish,
    sortPackagesByDependencyOrder,
} from './release';
import { findWorkspacePackages } from './workspace';

export interface BumpVersionOptions {
    push: boolean;
}

export interface DropTagsOptions {
    remote: boolean;
}

export async function publishPackages(
    refType = process.env.GITHUB_REF_TYPE,
    refName = process.env.GITHUB_REF_NAME,
): Promise<void> {
    const packages = await findWorkspacePackages();
    const selected = await selectPackagesForPublish(packages, refType, refName);
    const orderedSelected = await sortPackagesByDependencyOrder(selected);

    for (const pkg of orderedSelected) {
        if (npmViewVersion(pkg.name, pkg.version)) {
            console.log(`skip: ${pkg.name}@${pkg.version} already published`);
            continue;
        }

        console.log(`publish: ${pkg.name}@${pkg.version}`);
        const result = npmPublish(`${repoRoot}${pkg.dir}`);
        if (!result.ok) {
            if (isAlreadyPublishedError(result.output)) {
                console.log(`skip: ${pkg.name}@${pkg.version} already published (lost publish race)`);
                continue;
            }

            throw new Error(result.output);
        }

        console.log(result.output);
    }
}

export async function bumpVersion(version: string, options: BumpVersionOptions): Promise<void> {
    if (!SEMVER.test(version)) {
        throw new Error(`"${version}" is not a valid semver version (expected e.g. 0.1.4).`);
    }

    const packages = await findWorkspacePackages();
    const publishable = await sortPackagesByDependencyOrder(packages);
    const tags = publishable.map((pkg) => createReleaseTag(pkg, version));

    if (git(['status', '--porcelain']).stdout !== '') {
        throw new Error('working tree is not clean. Commit or stash changes before releasing.');
    }

    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout;
    if (branch === 'HEAD') {
        throw new Error('detached HEAD — checkout a branch before releasing.');
    }

    const existingLocal = new Set(git(['tag', '-l']).stdout.split('\n').filter(Boolean));
    const localClash = tags.filter((tag) => existingLocal.has(tag));
    if (localClash.length > 0) {
        throw new Error(
            `tags already exist locally: ${localClash.join(', ')}. Run "bun run drop-tags ${version}" first.`,
        );
    }

    const remoteRefs = git(['ls-remote', '--tags', 'origin']).stdout;
    const remoteClash = tags.filter((tag) => remoteRefs.includes(`refs/tags/${tag}`));
    if (remoteClash.length > 0) {
        throw new Error(
            `tags already exist on origin: ${remoteClash.join(', ')}. Run "bun run drop-tags ${version} --remote" first.`,
        );
    }

    const published = publishable.filter((pkg) => npmViewVersion(pkg.name, version));
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
        console.log(`  ${manifest.name}: ${previous} -> ${version}`);
    }
    console.log(`\nBumped ${packages.length} manifests to ${version}.`);

    const manifestPaths = packages.map((pkg) => (pkg.dir === '.' ? 'package.json' : `${pkg.dir}/package.json`));
    const optional = ['CHANGELOG.md', 'bun.lock'].filter((path) => Bun.file(`${repoRoot}${path}`).size > 0);
    mustGit(['add', ...manifestPaths, ...optional], 'git add');

    const commitMessage = `${releaseConfig.releaseCommitType}(${releaseConfig.releaseCommitScope}): ${releaseConfig.releaseCommitSubject(version)}`;
    mustGit(['commit', '-m', commitMessage], 'git commit');
    console.log(`Committed: ${commitMessage}`);

    for (const tag of tags) {
        mustGit(['tag', '-a', tag, '-m', releaseConfig.releaseTagMessage(tag)], `git tag ${tag}`);
        console.log(`  tagged ${tag}`);
    }

    if (!options.push) {
        console.log('\nDone (local). Review, then push to release:');
        console.log(`  git push origin ${branch}`);
        console.log('  git push origin --tags');
        console.log('Or re-run with --push next time to do this automatically.');
        return;
    }

    console.log('\nPushing branch (tags excluded)...');
    mustGit(['push', '--no-follow-tags', 'origin', branch], `git push origin ${branch}`);

    for (const tag of tags) {
        console.log(`Pushing tag ${tag}...`);
        mustGit(['push', 'origin', `refs/tags/${tag}`], `git push origin ${tag}`);
    }

    console.log(`\nReleased ${version}. The Publish workflow should now be running:`);
    console.log(`  gh run list --workflow=${releaseConfig.publishWorkflow} --limit ${releaseConfig.ghRunListLimit}`);
}

export async function dropTags(version: string, options: DropTagsOptions): Promise<void> {
    if (!SEMVER.test(version)) {
        throw new Error(`"${version}" is not a valid semver version (expected e.g. 0.1.2).`);
    }

    const packages = await findWorkspacePackages();
    const publishable = packages.filter((pkg) => !pkg.private);
    const tags = publishable.map((pkg) => createReleaseTag(pkg, version));
    const existingLocal = new Set(git(['tag', '-l']).stdout.split('\n').filter(Boolean));

    let deletedLocal = 0;
    let deletedRemote = 0;

    for (const tag of tags) {
        if (existingLocal.has(tag)) {
            const result = git(['tag', '-d', tag]);
            console.log(result.ok ? `  local  deleted ${tag}` : `  local  failed ${tag}: ${result.stderr}`);
            if (result.ok) deletedLocal++;
        } else {
            console.log(`  local  not present ${tag}`);
        }

        if (options.remote) {
            const result = git(['push', 'origin', `:refs/tags/${tag}`]);
            console.log(result.ok ? `  remote deleted ${tag}` : `  remote failed ${tag}: ${result.stderr}`);
            if (result.ok) deletedRemote++;
        }
    }

    console.log(
        `\nDeleted ${deletedLocal} local tag(s)${options.remote ? `, ${deletedRemote} remote tag(s)` : ''} for ${version}.`,
    );
    if (!options.remote) {
        console.log('Local only. Re-run with --remote to also delete the tags on origin.');
    }
}

function git(args: string[]) {
    return runCommand('git', args, { cwd: repoRoot });
}

function mustGit(args: string[], label: string): void {
    const result = git(args);
    if (!result.ok) {
        throw new Error(`\n${label} failed:\n${result.stderr || result.stdout}`);
    }
}
