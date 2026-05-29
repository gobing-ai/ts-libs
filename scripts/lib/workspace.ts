import { fileURLToPath } from 'node:url';
import { Glob } from 'bun';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export interface WorkspacePackage {
    /** Absolute path to the package's package.json. */
    path: string;
    /** Path relative to the repo root, e.g. "packages/utils". */
    dir: string;
    /** The "name" field, e.g. "@gobing-ai/ts-utils". */
    name: string;
    /** Current "version" field. */
    version: string;
    /** Whether the package is marked private (not published). */
    private: boolean;
}

/**
 * Discover all workspace packages by resolving the `workspaces` globs declared
 * in the root package.json — so adding a package or changing the glob needs no
 * script edits. The root manifest itself is included first.
 */
export async function findWorkspacePackages(): Promise<WorkspacePackage[]> {
    const rootManifestPath = `${repoRoot}package.json`;
    const rootPkg = await Bun.file(rootManifestPath).json();
    const patterns: string[] = rootPkg.workspaces ?? [];

    const packages: WorkspacePackage[] = [
        {
            path: rootManifestPath,
            dir: '.',
            name: rootPkg.name,
            version: rootPkg.version,
            private: rootPkg.private === true,
        },
    ];

    const seen = new Set<string>();
    for (const pattern of patterns) {
        // Each workspace entry is a directory glob (e.g. "packages/*"); the
        // manifest lives at <dir>/package.json.
        const glob = new Glob(`${pattern}/package.json`);
        for await (const rel of glob.scan({ cwd: repoRoot, onlyFiles: true })) {
            if (seen.has(rel)) continue;
            seen.add(rel);
            const pkg = await Bun.file(`${repoRoot}${rel}`).json();
            packages.push({
                path: `${repoRoot}${rel}`,
                dir: rel.replace(/\/package\.json$/, ''),
                name: pkg.name,
                version: pkg.version,
                private: pkg.private === true,
            });
        }
    }

    return packages;
}

export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
