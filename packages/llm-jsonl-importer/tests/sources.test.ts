import { describe, expect, test } from 'bun:test';
import { getSourceDefinition, SOURCE_DEFINITIONS } from '../src/sources';

describe('SOURCE_DEFINITIONS', () => {
    test('is an object with expected built-in source keys', () => {
        expect(typeof SOURCE_DEFINITIONS).toBe('object');
        expect(SOURCE_DEFINITIONS).not.toBeNull();

        const keys = Object.keys(SOURCE_DEFINITIONS);
        expect(keys.length).toBeGreaterThan(0);
        expect(keys).toContain('pi');
        expect(keys).toContain('claude');
        expect(keys).toContain('codex');
    });

    test('each definition has required fields', () => {
        for (const [key, def] of Object.entries(SOURCE_DEFINITIONS)) {
            expect(def).toHaveProperty('source');
            expect(def.source).toBe(key as typeof def.source);
            expect(def).toHaveProperty('displayName');
            expect(typeof def.displayName).toBe('string');
            expect(def).toHaveProperty('targetTable');
            expect(typeof def.targetTable).toBe('string');
            expect(def).toHaveProperty('filePatterns');
            expect(Array.isArray(def.filePatterns)).toBe(true);
            expect(def).toHaveProperty('splitConfig');
        }
    });

    test('getSourceDefinition returns the correct definition', () => {
        const piDef = getSourceDefinition('pi');
        expect(piDef.source).toBe('pi');
        expect(piDef.displayName).toBe('Pi');

        const claudeDef = getSourceDefinition('claude');
        expect(claudeDef.source).toBe('claude');
        expect(claudeDef.displayName).toBe('Claude Code');
    });
});
