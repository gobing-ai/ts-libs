#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { findWorkspacePackages, repoRoot, SEMVER } from './lib/workspace';

function git(args: string[]): { ok: boolean; stdout: string; stderr: string } {
    const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8' });
    return { ok: r.status === 0, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

const version = process.argv[2];
const remote = process.argv.includes('--remote');

if (!version) {
    console.error('Usage: bun run drop-tags <version> [--remote]');
    console.error('Example: bun run drop-tags 0.1.2            # delete local tags only');
    console.error('         bun run drop-tags 0.1.2 --remote   # also delete on origin');
    process.exit(1);
}

if (!SEMVER.test(version)) {
    console.error(`Error: "${version}" is not a valid semver version (expected e.g. 0.1.2).`);
    process.exit(1);
}

const packages = await findWorkspacePackages();
// Only publishable (non-private) packages get release tags.
const tags = packages.filter((p) => !p.private).map((p) => `${p.name}-v${version}`);

const existingLocal = new Set(git(['tag', '-l']).stdout.split('\n').filter(Boolean));

let deletedLocal = 0;
let deletedRemote = 0;

for (const tag of tags) {
    if (existingLocal.has(tag)) {
        const r = git(['tag', '-d', tag]);
        console.log(r.ok ? `  local  ✓ deleted ${tag}` : `  local  ✗ ${tag}: ${r.stderr}`);
        if (r.ok) deletedLocal++;
    } else {
        console.log(`  local  - not present ${tag}`);
    }

    if (remote) {
        // `git push origin :refs/tags/<tag>` deletes the remote ref; succeeds quietly if absent.
        const r = git(['push', 'origin', `:refs/tags/${tag}`]);
        console.log(r.ok ? `  remote ✓ deleted ${tag}` : `  remote ✗ ${tag}: ${r.stderr}`);
        if (r.ok) deletedRemote++;
    }
}

console.log(
    `\nDeleted ${deletedLocal} local tag(s)${remote ? `, ${deletedRemote} remote tag(s)` : ''} for ${version}.`,
);
if (!remote) {
    console.log('Local only. Re-run with --remote to also delete the tags on origin.');
}
