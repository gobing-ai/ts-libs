import { describe, expect, it } from 'bun:test';
import { InvalidProfileDirError } from '../src/errors';
import { resolveProfileDir } from '../src/profile-dir';

describe('resolveProfileDir (task 0088 R4)', () => {
    it('rejects empty and blank profile paths', () => {
        expect(() => resolveProfileDir('')).toThrow(InvalidProfileDirError);
        expect(() => resolveProfileDir('   ')).toThrow(/non-empty/);
    });

    it('resolves relative profile paths to absolute ones against the working directory', () => {
        const resolved = resolveProfileDir('profiles/xhs');
        expect(resolved.startsWith('/')).toBe(true);
        expect(resolved.endsWith('profiles/xhs')).toBe(true);
    });

    it('passes already-absolute profile paths through unchanged', () => {
        expect(resolveProfileDir('/tmp/browser-profiles/xhs')).toBe('/tmp/browser-profiles/xhs');
    });
});
