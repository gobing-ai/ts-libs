#!/usr/bin/env bun
import { findWorkspacePackages, SEMVER } from './lib/workspace';

const version = process.argv[2];

if (!version) {
    console.error('Usage: bun run bump-ver <version>');
    console.error('Example: bun run bump-ver 0.1.2');
    process.exit(1);
}

if (!SEMVER.test(version)) {
    console.error(`Error: "${version}" is not a valid semver version (expected e.g. 0.1.2).`);
    process.exit(1);
}

const packages = await findWorkspacePackages();

for (const pkg of packages) {
    const file = Bun.file(pkg.path);
    const manifest = await file.json();
    const previous = manifest.version;
    manifest.version = version;
    // Preserve 4-space indentation + trailing newline to match the repo's biome config.
    await Bun.write(pkg.path, `${JSON.stringify(manifest, null, 4)}\n`);
    console.log(`  ${manifest.name}: ${previous} -> ${version}`);
}

// Publishable packages = non-private. Tags use the package short-name suffix.
const publishable = packages.filter((p) => !p.private);
const tagSuffixes = publishable.map((p) => p.name.split('/').pop()).join(' ');

console.log(`\nBumped ${packages.length} manifests to ${version}.`);
console.log('Next steps:');
console.log('  bun install                              # resync bun.lock');
console.log(`  git commit -am "release: bump all packages to ${version}"`);
console.log(`  for p in ${tagSuffixes}; do git tag -a "@gobing-ai/$p-v${version}" -m "release: $p ${version}"; done`);
console.log('  git push origin main                     # followTags carries the annotated tags');
