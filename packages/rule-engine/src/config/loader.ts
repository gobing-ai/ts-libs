import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { loadStructuredConfig, NodeFileSystem } from '@gobing-ai/ts-runtime';
import {
    type ConstraintRule,
    type ConstraintRuleFile,
    ConstraintRuleFileSchema,
    ConstraintRuleSchema,
    type PresetDefinition,
    PresetDefinitionSchema,
} from '../types';
import { collectPresetExtensions, type ExtensionRef } from './extensions';

/** Options for loading rule presets. */
export interface RuleLoaderOptions {
    /**
     * Ordered rule root directories, highest priority first. Presets, category
     * folders, and rule files are resolved across all roots: the highest-priority
     * root that provides a given relative path wins, and gaps are filled from
     * lower-priority roots. The caller owns root discovery and ordering — this
     * loader stays agnostic to any project layout convention.
     */
    roots: string[];
    /** When true, honor top-level `$schema` refs in preset and rule files. Defaults to true. */
    validateSchema?: boolean;
    /** Optional fetch implementation for remote HTTP(S) schema refs. */
    fetch?: (input: string) => Promise<Response>;
}

export interface RuleFileLoadOptions {
    /** When true, honor top-level `$schema` refs. Defaults to true. */
    validateSchema?: boolean;
    /** Optional fetch implementation for remote HTTP(S) schema refs. */
    fetch?: (input: string) => Promise<Response>;
}

/** Loaded preset rules plus extension module refs declared by composed presets. */
export interface LoadedPreset {
    /** Normalized rules after preset disable/override handling. */
    readonly rules: ConstraintRule[];
    /** Extension modules declared by the preset graph, resolved to absolute paths. */
    readonly extensions: ExtensionRef[];
}

/** Merged view of rule roots: winning file per relative path, plus categories. */
interface MergedRoots {
    /** Normalized relative path (e.g. `quality/coverage-gate.yaml`) → winning absolute path. */
    readonly files: ReadonlyMap<string, string>;
    /** Category folder names visible across all roots. */
    readonly categories: ReadonlySet<string>;
}

/**
 * Load and normalize a preset by name, resolving across one or more rule roots.
 *
 * Roots are merged in order: the first root to provide a relative path owns it,
 * so a caller can layer project-local rules over shared/global rules and inherit
 * the rest of a preset's categories from the lower-priority roots.
 */
export async function loadPreset(name: string, options: RuleLoaderOptions): Promise<LoadedPreset> {
    const merged = await buildMergedRoots(options.roots.map((root) => resolve(root)));
    const presetPath = findMergedPreset(merged, name);
    if (presetPath === null) return { rules: [], extensions: [] };
    const preset = PresetDefinitionSchema.parse(await readStructuredFile(presetPath, options)) as PresetDefinition;
    const rules: ConstraintRule[] = [];
    const extensions = collectPresetExtensions(preset.name, dirname(presetPath), preset.extensions);
    for (const entry of preset.extends) {
        const loaded = await loadPresetEntry(merged, entry, new Set([name]), options);
        rules.push(...loaded.rules);
        extensions.push(...loaded.extensions);
    }
    const disabled = new Set(preset.disable ?? []);
    const normalized = rules.filter((rule) => !disabled.has(rule.id));
    for (const rule of normalized) {
        const override = preset.overrides?.[rule.id];
        if (override?.fix !== undefined) {
            rule.fix = { ...(rule.fix ?? { mode: 'none' }), ...override.fix };
        }
    }
    return { rules: normalized, extensions };
}

export async function loadPresetRules(name: string, options: RuleLoaderOptions): Promise<ConstraintRule[]> {
    return (await loadPreset(name, options)).rules;
}

/** Load a direct rule file from disk. */
export async function loadRuleFile(filePath: string, options: RuleFileLoadOptions = {}): Promise<ConstraintRule[]> {
    const resolved = resolve(filePath);
    return normalizeRuleFile(await readStructuredFile(resolved, options), dirname(resolved));
}

async function loadPresetEntry(
    merged: MergedRoots,
    entry: string,
    seen: Set<string>,
    options: Pick<RuleLoaderOptions, 'validateSchema' | 'fetch'>,
): Promise<LoadedPreset> {
    // Sub-preset reference — recurse, erroring on a genuine cycle.
    const presetPath = findMergedPreset(merged, entry);
    if (presetPath !== null) {
        if (seen.has(entry)) {
            throw new Error(`Circular preset dependency detected: ${[...seen, entry].join(' → ')}`);
        }
        const nextSeen = new Set([...seen, entry]);
        const preset = PresetDefinitionSchema.safeParse(await readStructuredFile(presetPath, options));
        if (preset.success) {
            const rules: ConstraintRule[] = [];
            const extensions = collectPresetExtensions(preset.data.name, dirname(presetPath), preset.data.extensions);
            for (const child of preset.data.extends) {
                const loaded = await loadPresetEntry(merged, child, nextSeen, options);
                rules.push(...loaded.rules);
                extensions.push(...loaded.extensions);
            }
            return { rules: rules.filter((rule) => !(preset.data.disable ?? []).includes(rule.id)), extensions };
        }
    }

    // Category folder reference — load every winning file under that prefix.
    if (merged.categories.has(entry)) {
        const rules: ConstraintRule[] = [];
        for (const absPath of mergedFilesInCategory(merged, entry)) {
            rules.push(...normalizeRuleFile(await readStructuredFile(absPath, options), dirname(absPath)));
        }
        return { rules, extensions: [] };
    }

    // Sub-path reference — a single winning rule file within a category.
    const subPath = findMergedFile(merged, entry);
    if (subPath !== null)
        return {
            rules: normalizeRuleFile(await readStructuredFile(subPath, options), dirname(subPath)),
            extensions: [],
        };

    return { rules: [], extensions: [] };
}

/**
 * Build the merged view across ordered roots.
 *
 * Roots are processed in the order supplied (highest priority first). The first
 * root to provide a given relative path owns that file; later roots are shadowed.
 */
async function buildMergedRoots(roots: readonly string[]): Promise<MergedRoots> {
    const fs = new NodeFileSystem();
    const files = new Map<string, string>();
    const categories = new Set<string>();
    for (const root of roots) {
        for (const absPath of await walkYamlFiles(fs, root)) {
            const relPath = relative(root, absPath).split(sep).join('/');
            const slashIdx = relPath.indexOf('/');
            if (slashIdx > 0) categories.add(relPath.slice(0, slashIdx));
            if (!files.has(relPath)) files.set(relPath, absPath);
        }
        for (const dir of await listImmediateDirs(fs, root)) categories.add(dir);
    }
    return { files, categories };
}

/** Find a preset definition across roots: `<name>.{yaml,yml,json}` or `<name>/index.*`. */
function findMergedPreset(merged: MergedRoots, name: string): string | null {
    return firstHit(merged, [
        `${name}.yaml`,
        `${name}.yml`,
        `${name}.json`,
        `${name}/index.yaml`,
        `${name}/index.yml`,
        `${name}/index.json`,
    ]);
}

/** Find a single rule file by sub-path entry (e.g. `typescript/tsdoc-exports`). */
function findMergedFile(merged: MergedRoots, entry: string): string | null {
    const hasExt = /\.(ya?ml|json)$/i.test(entry);
    return firstHit(merged, hasExt ? [entry] : [`${entry}.yaml`, `${entry}.yml`, `${entry}.json`]);
}

/** Return the winning absolute path for the first matching relative candidate. */
function firstHit(merged: MergedRoots, relCandidates: readonly string[]): string | null {
    for (const rel of relCandidates) {
        const hit = merged.files.get(rel);
        if (hit !== undefined) return hit;
    }
    return null;
}

/** Winning files under a category prefix, sorted by relative path. */
function mergedFilesInCategory(merged: MergedRoots, category: string): string[] {
    const prefix = `${category}/`;
    return [...merged.files.entries()]
        .filter(([relPath]) => relPath.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, absPath]) => absPath);
}

/** Recursively collect YAML/JSON file paths under a directory, skipping root-level `presets/`. */
async function walkYamlFiles(fs: NodeFileSystem, dir: string, depth = 0): Promise<string[]> {
    const stat = await fs.stat(dir);
    if (stat === null || !stat.isDirectory()) return [];
    const acc: string[] = [];
    for (const entry of (await fs.readDir(dir)).sort()) {
        if (depth === 0 && entry === 'presets') continue;
        const fullPath = join(dir, entry);
        const entryStat = await fs.stat(fullPath);
        if (entryStat?.isDirectory()) {
            acc.push(...(await walkYamlFiles(fs, fullPath, depth + 1)));
        } else if (entryStat?.isFile() && /\.(ya?ml|json)$/i.test(entry)) {
            acc.push(fullPath);
        }
    }
    return acc;
}

/** List immediate subdirectory names of a root (excluding `presets`). */
async function listImmediateDirs(fs: NodeFileSystem, dir: string): Promise<string[]> {
    const stat = await fs.stat(dir);
    if (stat === null || !stat.isDirectory()) return [];
    const dirs: string[] = [];
    for (const entry of await fs.readDir(dir)) {
        if (entry === 'presets') continue;
        const entryStat = await fs.stat(join(dir, entry));
        if (entryStat?.isDirectory()) dirs.push(entry);
    }
    return dirs;
}

async function readStructuredFile(
    path: string,
    options: Pick<RuleLoaderOptions, 'validateSchema' | 'fetch'> = {},
): Promise<unknown> {
    return await loadStructuredConfig(path, {
        validateSchema: options.validateSchema,
        fetch: options.fetch,
    });
}

function normalizeRuleFile(raw: unknown, sourceDir: string): ConstraintRule[] {
    const maybeFile = ConstraintRuleFileSchema.safeParse(raw);
    if (maybeFile.success) return normalizeFileRules(maybeFile.data, sourceDir);
    const maybeRule = ConstraintRuleSchema.safeParse(raw);
    if (maybeRule.success) return [normalizeRule(maybeRule.data, {}, sourceDir)];
    throw new Error(`Invalid rule file: ${basename(sourceDir)}`);
}

function normalizeFileRules(file: ConstraintRuleFile, sourceDir: string): ConstraintRule[] {
    return file.rules.map((rule) =>
        normalizeRule(
            {
                ...rule,
                severity: rule.severity ?? file.severity ?? 'error',
                include: rule.include ?? file.include,
                // File-level excludes always apply; a rule's own excludes add to (not replace) them.
                exclude: mergeExcludes(file.exclude, rule.exclude),
            },
            {},
            sourceDir,
        ),
    );
}

/** Union of file-level and rule-level excludes, de-duplicated. Returns undefined when both empty. */
function mergeExcludes(fileExclude?: string[], ruleExclude?: string[]): string[] | undefined {
    if (fileExclude === undefined && ruleExclude === undefined) return undefined;
    return [...new Set([...(fileExclude ?? []), ...(ruleExclude ?? [])])];
}

function normalizeRule(rule: ConstraintRule, _defaults: Partial<ConstraintRule>, _sourceDir: string): ConstraintRule {
    return {
        ...rule,
        enabled: rule.enabled ?? true,
        severity: rule.severity ?? 'error',
    };
}
