import { describe, expect, test } from 'bun:test';
import {
    assertNoWorkspaceRanges,
    isWorkspaceRange,
    resolveWorkspaceRange,
    substituteWorkspaceRanges,
} from '../lib/workspace-deps';

describe('isWorkspaceRange', () => {
    test('detects the workspace protocol', () => {
        expect(isWorkspaceRange('workspace:*')).toBe(true);
        expect(isWorkspaceRange('workspace:^')).toBe(true);
        expect(isWorkspaceRange('workspace:^1.2.3')).toBe(true);
        expect(isWorkspaceRange('^0.2.0')).toBe(false);
        expect(isWorkspaceRange('0.2.0')).toBe(false);
    });
});

describe('resolveWorkspaceRange', () => {
    test('workspace:* and workspace:^ become a caret range', () => {
        expect(resolveWorkspaceRange('workspace:*', '0.2.0')).toBe('^0.2.0');
        expect(resolveWorkspaceRange('workspace:^', '1.4.2')).toBe('^1.4.2');
    });

    test('workspace:~ becomes a tilde range', () => {
        expect(resolveWorkspaceRange('workspace:~', '0.2.0')).toBe('~0.2.0');
    });

    test('an explicit range after the protocol wins', () => {
        expect(resolveWorkspaceRange('workspace:>=1.0.0', '2.0.0')).toBe('>=1.0.0');
    });
});

describe('substituteWorkspaceRanges', () => {
    const versions = new Map([
        ['@gobing-ai/ts-db', '0.2.0'],
        ['@gobing-ai/ts-runtime', '0.2.0'],
    ]);

    test('rewrites workspace ranges across all dependency fields', () => {
        const { manifest, changed } = substituteWorkspaceRanges(
            {
                dependencies: { '@gobing-ai/ts-db': 'workspace:*', zod: '^4.1.0' },
                devDependencies: { '@gobing-ai/ts-runtime': 'workspace:^' },
            },
            versions,
        );
        expect(changed).toBe(2);
        expect(manifest.dependencies).toEqual({ '@gobing-ai/ts-db': '^0.2.0', zod: '^4.1.0' });
        expect(manifest.devDependencies).toEqual({ '@gobing-ai/ts-runtime': '^0.2.0' });
    });

    test('leaves non-workspace ranges and missing fields untouched', () => {
        const { manifest, changed } = substituteWorkspaceRanges({ dependencies: { zod: '^4.1.0' } }, versions);
        expect(changed).toBe(0);
        expect(manifest.dependencies).toEqual({ zod: '^4.1.0' });
    });

    test('does not mutate the input manifest', () => {
        const input = { dependencies: { '@gobing-ai/ts-db': 'workspace:*' } };
        substituteWorkspaceRanges(input, versions);
        expect(input.dependencies['@gobing-ai/ts-db']).toBe('workspace:*');
    });

    test('resolves workspace ranges in peerDependencies (ADR-012 addendum)', () => {
        const { manifest, changed } = substituteWorkspaceRanges(
            {
                peerDependencies: { '@gobing-ai/ts-db': 'workspace:*' },
                peerDependenciesMeta: { '@gobing-ai/ts-db': { optional: true } },
                devDependencies: { '@gobing-ai/ts-db': 'workspace:*' },
            },
            versions,
        );
        expect(changed).toBe(2);
        expect(manifest.peerDependencies).toEqual({ '@gobing-ai/ts-db': '^0.2.0' });
        expect(manifest.devDependencies).toEqual({ '@gobing-ai/ts-db': '^0.2.0' });
        // peerDependenciesMeta is not a version-bearing field — must survive untouched.
        expect(manifest.peerDependenciesMeta).toEqual({ '@gobing-ai/ts-db': { optional: true } });
    });

    test('throws when a workspace dep has no known version', () => {
        expect(() =>
            substituteWorkspaceRanges({ dependencies: { '@gobing-ai/ts-unknown': 'workspace:*' } }, versions),
        ).toThrow('no known version');
    });
});

describe('assertNoWorkspaceRanges (fail-closed)', () => {
    test('passes when no workspace ranges remain', () => {
        expect(() =>
            assertNoWorkspaceRanges({ dependencies: { '@gobing-ai/ts-db': '^0.2.0' } }, '@gobing-ai/ts-x'),
        ).not.toThrow();
    });

    test('throws when a workspace range survives', () => {
        expect(() =>
            assertNoWorkspaceRanges({ dependencies: { '@gobing-ai/ts-db': 'workspace:*' } }, '@gobing-ai/ts-x'),
        ).toThrow('refusing to publish');
    });
});
