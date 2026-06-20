import { createNodeFileSystem, dirnamePath, type FileSystem, joinPath } from '@gobing-ai/ts-runtime';

/**
 * Directory name holding the rule presets and category folders bundled with this
 * package. Lives at the package root (sibling to `dist/`), shipped via the
 * package `files` allowlist.
 */
const BUNDLED_RULES_DIR = 'rules';

/** Memoized result so the upward filesystem walk runs at most once per process. */
let cachedRoot: string | null | undefined;
/** In-flight resolution to prevent racing concurrent calls. */
let resolving: Promise<string | null> | undefined;

/**
 * Resolve the absolute path to the rule presets bundled with
 * `@gobing-ai/ts-rule-engine`.
 *
 * The directory ships a generic example preset and category
 * folders (`typescript`, `structure`, `quality`) so a consumer gets a working
 * default ruleset without authoring any files. Pass the returned path as the
 * lowest-priority entry to {@link loadPreset}'s `roots`, letting project-local
 * and user-global roots shadow individual files while inheriting the rest.
 *
 * Resolution walks up from this module's compiled location (under `dist/` at
 * runtime, under `src/` in tests) until it finds the bundled `rules/` directory,
 * which makes it robust to the build's `src`→`dist` layout shift. Returns `null`
 * if the directory is absent (e.g. a partial install that excluded the assets).
 */
export async function bundledRulesRoot(): Promise<string | null> {
    if (cachedRoot !== undefined) return cachedRoot;
    if (resolving !== undefined) return resolving;
    resolving = bundledRulesRootWithFs(createNodeFileSystem());
    cachedRoot = await resolving;
    resolving = undefined;
    return cachedRoot;
}

async function bundledRulesRootWithFs(fs: FileSystem): Promise<string | null> {
    let dir = import.meta.dirname;
    while (true) {
        const candidate = joinPath(dir, BUNDLED_RULES_DIR);
        const st = await fs.stat(candidate);
        if (st?.isDirectory() === true) {
            return candidate;
        }
        const parent = dirnamePath(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/**
 * List the relative paths of every bundled rule asset (presets and category rule
 * files), each as a `/`-joined path relative to {@link bundledRulesRoot}.
 *
 * Intended for consumers that copy the bundled rules into a writable location
 * (e.g. a per-user global rules directory) on first run. Returns an empty array
 * when no bundled directory is present.
 */
export async function listBundledRuleFiles(): Promise<string[]> {
    const root = await bundledRulesRoot();
    if (root === null) return [];
    return (await walk(createNodeFileSystem(), root, '')).sort();
}

/** Recursively collect YAML/JSON files under `dir`, returning paths relative to the walk origin. */
async function walk(fs: FileSystem, dir: string, relPrefix: string): Promise<string[]> {
    const acc: string[] = [];
    for (const entry of await fs.readDir(dir)) {
        const abs = joinPath(dir, entry);
        const rel = relPrefix.length > 0 ? `${relPrefix}/${entry}` : entry;
        const st = await fs.stat(abs);
        if (st?.isDirectory() === true) {
            acc.push(...(await walk(fs, abs, rel)));
        } else if (/\.(ya?ml|json)$/i.test(entry)) {
            acc.push(rel);
        }
    }
    return acc;
}
