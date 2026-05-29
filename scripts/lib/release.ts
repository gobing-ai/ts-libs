import { releaseConfig, SEMVER } from '../config';
import type { Spawn } from './command';
import { runCommand } from './command';
import type { WorkspacePackage } from './workspace';

export interface ReleaseTag {
    name: string;
    version: string;
}

const SEMVER_PATTERN = SEMVER.source.replace(/^\^/, '').replace(/\$$/, '');

export function parseReleaseTag(tag: string): ReleaseTag | undefined {
    const escapedSeparator = releaseConfig.tagVersionSeparator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefix = releaseConfig.packageNamePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = tag.match(new RegExp(`^(${prefix}[a-z0-9][a-z0-9._-]*)${escapedSeparator}(${SEMVER_PATTERN})$`));
    if (!match) return undefined;

    return { name: match[1], version: match[2] };
}

export function createReleaseTag(pkg: WorkspacePackage, version: string): string {
    return `${pkg.name}${releaseConfig.tagVersionSeparator}${version}`;
}

export function branchPushArgs(branch: string): string[] {
    return ['-c', 'push.followTags=false', 'push', '--no-follow-tags', 'origin', branch];
}

export function tagPushArgs(tag: string): string[] {
    return ['-c', 'push.followTags=false', 'push', 'origin', `refs/tags/${tag}:refs/tags/${tag}`];
}

export async function sortPackagesByDependencyOrder(packages: WorkspacePackage[]): Promise<WorkspacePackage[]> {
    const publishable = packages.filter((pkg) => !pkg.private);
    const packageByName = new Map(packages.map((pkg) => [pkg.name, pkg]));
    const publishableByName = new Map(publishable.map((pkg) => [pkg.name, pkg]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const sorted: WorkspacePackage[] = [];

    function visit(pkg: WorkspacePackage): void {
        if (visited.has(pkg.name)) return;
        if (visiting.has(pkg.name)) {
            throw new Error(`internal package dependency cycle includes ${pkg.name}`);
        }

        visiting.add(pkg.name);

        for (const dependencyName of Object.keys(pkg.dependencies)) {
            const dependency = packageByName.get(dependencyName);
            if (dependency) visit(dependency);
        }

        visiting.delete(pkg.name);
        visited.add(pkg.name);

        if (publishableByName.has(pkg.name)) {
            sorted.push(pkg);
        }
    }

    for (const pkg of publishable) {
        visit(pkg);
    }

    return sorted;
}

export async function selectPackagesForPublish(
    packages: WorkspacePackage[],
    refType: string | undefined,
    refName: string | undefined,
): Promise<WorkspacePackage[]> {
    if (refType !== 'tag') {
        return sortPackagesByDependencyOrder(packages);
    }

    if (!refName) {
        throw new Error('GITHUB_REF_TYPE is "tag" but GITHUB_REF_NAME is empty');
    }

    const releaseTag = parseReleaseTag(refName);
    if (!releaseTag) {
        throw new Error(`unsupported release tag: ${refName}`);
    }

    const pkg = packages.find((candidate) => candidate.name === releaseTag.name);
    if (!pkg) {
        throw new Error(`release tag ${refName} names ${releaseTag.name}, but no workspace package has that name`);
    }

    if (pkg.private) {
        throw new Error(`release tag ${refName} names private package ${pkg.name}`);
    }

    if (pkg.version !== releaseTag.version) {
        throw new Error(`tag ${refName} expects ${pkg.name}@${releaseTag.version}, but ${pkg.path} has ${pkg.version}`);
    }

    return [pkg];
}

export function npmViewVersion(name: string, version: string, spawn?: Spawn): boolean {
    const result = runCommand(
        'npm',
        ['view', `${name}@${version}`, 'version'],
        {
            stdio: ['ignore', 'pipe', 'ignore'],
        },
        spawn,
    );

    return result.ok && result.stdout !== '';
}

export function npmPublish(dir: string, spawn?: Spawn): { ok: boolean; output: string } {
    const result = runCommand(
        'npm',
        ['publish', '--access', 'public'],
        {
            cwd: dir,
            stdio: ['ignore', 'pipe', 'pipe'],
        },
        spawn,
    );

    return {
        ok: result.ok,
        output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim(),
    };
}

export function isAlreadyPublishedError(output: string): boolean {
    return /cannot publish over|previously published|already exists|E409|EPUBLISHCONFLICT/i.test(output);
}
