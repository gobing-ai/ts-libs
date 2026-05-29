#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { findWorkspacePackages, repoRoot, SEMVER } from './lib/workspace';

function git(args: string[]): { ok: boolean; stdout: string; stderr: string } {
    const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8' });
    return { ok: r.status === 0, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

function run(args: string[], label: string): void {
    const r = git(args);
    if (!r.ok) {
        console.error(`\n✗ ${label} failed:\n${r.stderr || r.stdout}`);
        process.exit(1);
    }
}

function fail(message: string): never {
    console.error(`Error: ${message}`);
    process.exit(1);
}

const args = process.argv.slice(2);
const push = args.includes('--push');
const version = args.find((a) => !a.startsWith('--'));

if (!version) {
    console.error('Usage: bun run bump-ver <version> [--push]');
    console.error('  Default: bump manifests, commit, create annotated tags (then stop).');
    console.error('  --push : also push the branch and tags (triggers the Publish workflow).');
    console.error('Example: bun run bump-ver 0.1.4 --push');
    process.exit(1);
}

if (!SEMVER.test(version)) {
    fail(`"${version}" is not a valid semver version (expected e.g. 0.1.4).`);
}

const packages = await findWorkspacePackages();
const publishable = packages.filter((p) => !p.private);
const tags = publishable.map((p) => `${p.name}-v${version}`);

// --- Pre-flight checks (fail loud before mutating anything) ---

// 1. Clean working tree — a release commit must contain only the version bump.
if (git(['status', '--porcelain']).stdout !== '') {
    fail('working tree is not clean. Commit or stash changes before releasing.');
}

// 2. On a branch (not detached HEAD).
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout;
if (branch === 'HEAD') {
    fail('detached HEAD — checkout a branch before releasing.');
}

// 3. No tag for this version exists — locally OR on the remote.
const existingLocal = new Set(git(['tag', '-l']).stdout.split('\n').filter(Boolean));
const localClash = tags.filter((t) => existingLocal.has(t));
if (localClash.length > 0) {
    fail(`tags already exist locally: ${localClash.join(', ')}. Run "bun run drop-tags ${version}" first.`);
}

const remoteRefs = git(['ls-remote', '--tags', 'origin']).stdout;
const remoteClash = tags.filter((t) => remoteRefs.includes(`refs/tags/${t}`));
if (remoteClash.length > 0) {
    fail(`tags already exist on origin: ${remoteClash.join(', ')}. Run "bun run drop-tags ${version} --remote" first.`);
}

// 4. The version is not already published on npm (would E403 on publish).
// stderr is silenced — an unpublished version legitimately returns E404.
const published = publishable.filter((p) => {
    const r = spawnSync('npm', ['view', `${p.name}@${version}`, 'version'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    return r.status === 0 && (r.stdout ?? '').trim() !== '';
});
if (published.length > 0) {
    fail(`already published on npm at ${version}: ${published.map((p) => p.name).join(', ')}. Use a new version.`);
}

// --- Bump every manifest ---
for (const pkg of packages) {
    const manifest = await Bun.file(pkg.path).json();
    const previous = manifest.version;
    manifest.version = version;
    // Preserve 4-space indentation + trailing newline to match the repo's biome config.
    await Bun.write(pkg.path, `${JSON.stringify(manifest, null, 4)}\n`);
    console.log(`  ${manifest.name}: ${previous} -> ${version}`);
}
console.log(`\nBumped ${packages.length} manifests to ${version}.`);

// --- Commit (only the files a release should touch) ---
const manifestPaths = packages.map((p) => (p.dir === '.' ? 'package.json' : `${p.dir}/package.json`));
// CHANGELOG.md and bun.lock are optional — add only if present/changed.
const optional = ['CHANGELOG.md', 'bun.lock'].filter((f) => Bun.file(`${repoRoot}${f}`).size > 0);
run(['add', ...manifestPaths, ...optional], 'git add');
run(['commit', '-m', `chore(release): bump all packages to ${version}`], 'git commit');
console.log(`Committed: chore(release): bump all packages to ${version}`);

for (const tag of tags) {
    run(['tag', '-a', tag, '-m', `release: ${tag}`], `git tag ${tag}`);
    console.log(`  tagged ${tag}`);
}

// --- Push (opt-in) ---
if (!push) {
    console.log('\nDone (local). Review, then push to release:');
    console.log(`  git push origin ${branch}`);
    console.log('  git push origin --tags');
    console.log('Or re-run with --push next time to do this automatically.');
    process.exit(0);
}

// Push the branch WITHOUT its tags first. --no-follow-tags is essential: with
// push.followTags=true, a plain branch push carries the annotated tags along in
// the same event, which GitHub attributes to the branch.
console.log('\nPushing branch (tags excluded)...');
run(['push', '--no-follow-tags', 'origin', branch], `git push origin ${branch}`);

// Push tags ONE AT A TIME. GitHub does not create workflow runs when more than
// three tags are pushed in a single operation — `git push --tags` with 4+ tags
// silently triggers nothing. A single-ref push reliably fires the tag event.
// The Publish workflow's idempotent loop publishes every package on any single
// trigger, so each per-tag push re-runs it harmlessly (already-published skip).
for (const tag of tags) {
    console.log(`Pushing tag ${tag}...`);
    run(['push', 'origin', `refs/tags/${tag}`], `git push origin ${tag}`);
}

console.log(`\n✓ Released ${version}. The Publish workflow should now be running:`);
console.log('  gh run list --workflow=publish.yml --limit 3');
