import { basename, dirname, extname, join, resolve } from 'node:path';
import { NodeFileSystem } from '@gobing-ai/ts-runtime';
import { parse } from 'yaml';
import {
    type ConstraintRule,
    type ConstraintRuleFile,
    ConstraintRuleFileSchema,
    ConstraintRuleSchema,
    type PresetDefinition,
    PresetDefinitionSchema,
} from '../types';

/** Options for loading rule presets. */
export interface RuleLoaderOptions {
    /** Project working directory. */
    workdir: string;
    /** Rule root directory. Defaults to ".spur/rules". */
    rulesRoot?: string;
}

/** Load and normalize a preset by name. */
export async function loadPresetRules(name: string, options: RuleLoaderOptions): Promise<ConstraintRule[]> {
    const fs = new NodeFileSystem();
    const root = resolve(options.workdir, options.rulesRoot ?? '.spur/rules');
    const presetPath = await findDefinitionPath(root, name);
    if (presetPath === null) return [];
    const preset = PresetDefinitionSchema.parse(await readStructuredFile(presetPath)) as PresetDefinition;
    const rules: ConstraintRule[] = [];
    for (const entry of preset.extends) {
        rules.push(...(await loadPresetEntry(root, entry, new Set([name]))));
    }
    const disabled = new Set(preset.disable ?? []);
    const normalized = rules.filter((rule) => !disabled.has(rule.id));
    for (const rule of normalized) {
        const override = preset.overrides?.[rule.id];
        if (override?.fix !== undefined) {
            rule.fix = { ...(rule.fix ?? { mode: 'none' }), ...override.fix };
        }
    }
    await fs.exists(root);
    return normalized;
}

/** Load a direct rule file from disk. */
export async function loadRuleFile(filePath: string): Promise<ConstraintRule[]> {
    return normalizeRuleFile(await readStructuredFile(resolve(filePath)), dirname(resolve(filePath)));
}

async function loadPresetEntry(root: string, entry: string, seen: Set<string>): Promise<ConstraintRule[]> {
    const presetPath = await findDefinitionPath(root, entry);
    if (presetPath !== null && !seen.has(entry)) {
        seen.add(entry);
        const preset = PresetDefinitionSchema.safeParse(await readStructuredFile(presetPath));
        if (preset.success) {
            const rules: ConstraintRule[] = [];
            for (const child of preset.data.extends) rules.push(...(await loadPresetEntry(root, child, seen)));
            return rules.filter((rule) => !(preset.data.disable ?? []).includes(rule.id));
        }
    }

    const categoryDir = resolve(root, entry);
    const fs = new NodeFileSystem();
    if (!(await fs.exists(categoryDir))) return [];
    const entries = (await fs.readDir(categoryDir)).filter((file) => /\.(ya?ml|json)$/i.test(file)).sort();
    const rules: ConstraintRule[] = [];
    for (const file of entries) {
        rules.push(...(await loadRuleFile(join(categoryDir, file))));
    }
    return rules;
}

async function findDefinitionPath(root: string, name: string): Promise<string | null> {
    const fs = new NodeFileSystem();
    const candidates = [
        resolve(root, `${name}.yaml`),
        resolve(root, `${name}.yml`),
        resolve(root, `${name}.json`),
        resolve(root, name, 'index.yaml'),
        resolve(root, name, 'index.yml'),
        resolve(root, name, 'index.json'),
    ];
    for (const candidate of candidates) {
        if (await fs.exists(candidate)) return candidate;
    }
    return null;
}

async function readStructuredFile(path: string): Promise<unknown> {
    const content = await new NodeFileSystem().readFile(path);
    return extname(path) === '.json' ? JSON.parse(content) : parse(content);
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
                exclude: rule.exclude ?? file.exclude,
            },
            {},
            sourceDir,
        ),
    );
}

function normalizeRule(rule: ConstraintRule, _defaults: Partial<ConstraintRule>, _sourceDir: string): ConstraintRule {
    return {
        ...rule,
        enabled: rule.enabled ?? true,
        severity: rule.severity ?? 'error',
    };
}
