import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { bundledRulesRoot, listBundledRuleFiles, loadPreset } from '../../src';

describe('bundledRulesRoot', () => {
    test('resolves an existing absolute directory shipped with the package', () => {
        const root = bundledRulesRoot();
        expect(root).not.toBeNull();
        expect(isAbsolute(root as string)).toBe(true);
        expect(existsSync(root as string)).toBe(true);
        expect(basename(root as string)).toBe('rules');
    });

    test('is memoized — repeated calls return the same path', () => {
        expect(bundledRulesRoot()).toBe(bundledRulesRoot());
    });
});

describe('listBundledRuleFiles', () => {
    test('lists the bundled presets and category rule files as sorted relative paths', () => {
        const files = listBundledRuleFiles();
        // Presets live at the root; category rules live under their folders.
        expect(files).toContain('recommended.yaml');
        expect(files).toContain('spur-dev.yaml');
        expect(files).toContain('quality/tsdoc-exports.yaml');
        expect(files).toContain('structure/test-location.yaml');
        expect(files).toContain('quality/coverage-gate.yaml');
        // No absolute paths leak out — these are copy-source-relative.
        for (const file of files) expect(isAbsolute(file)).toBe(false);
        expect([...files]).toEqual([...files].sort());
    });
});

describe('loadPreset against the bundled root', () => {
    test('recommended composes every bundled category into a non-empty ruleset', async () => {
        const root = bundledRulesRoot();
        const { rules } = await loadPreset('recommended', { roots: [root as string] });
        const ids = rules.map((rule) => rule.id);
        // One rule from each composed category proves the preset graph resolves.
        expect(ids).toContain('every-export-has-tsdoc');
        expect(ids).toContain('no-tests-dir');
        expect(ids).toContain('coverage-gate');
        expect(rules.length).toBeGreaterThan(0);
    });

    test('spur-dev resolves typescript rules plus the single coverage-gate file', async () => {
        const root = bundledRulesRoot();
        const { rules } = await loadPreset('spur-dev', { roots: [root as string] });
        const ids = rules.map((rule) => rule.id);
        expect(ids).toContain('coverage-gate');
        expect(ids).toContain('every-export-has-tsdoc');
    });
});
