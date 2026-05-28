import { describe, expect, test } from 'bun:test';

import { getRoles, hasRole } from '../src/access';

describe('hasRole', () => {
    test('rejects nullish profiles and empty role names', () => {
        expect(hasRole(null, 'admin')).toBe(false);
        expect(hasRole(undefined, 'admin')).toBe(false);
        expect(hasRole({ roles: ['admin'] }, '')).toBe(false);
    });

    test('detects Zitadel and generic role claims', () => {
        expect(
            hasRole(
                {
                    'urn:zitadel:iam:org:project:roles': { admin: 'project-1', viewer: 'project-1' },
                },
                'admin',
            ),
        ).toBe(true);
        expect(hasRole({ roles: ['admin', 'viewer'] }, 'viewer')).toBe(true);
        expect(hasRole({ roles: { admin: true, viewer: false } }, 'viewer')).toBe(true);
    });

    test('returns false for unsupported role shapes or missing roles', () => {
        expect(hasRole({ 'urn:zitadel:iam:org:project:roles': ['admin'] }, 'admin')).toBe(false);
        expect(hasRole({ roles: ['admin'] }, 'editor')).toBe(false);
        expect(hasRole({ sub: 'user-1' }, 'admin')).toBe(false);
    });
});

describe('getRoles', () => {
    test('returns an empty array for nullish profiles and profiles without roles', () => {
        expect(getRoles(null)).toEqual([]);
        expect(getRoles(undefined)).toEqual([]);
        expect(getRoles({ sub: 'user-1' })).toEqual([]);
    });

    test('extracts and deduplicates roles from supported claim formats', () => {
        const roles = getRoles({
            'urn:zitadel:iam:org:project:roles': { admin: 'p1' },
            roles: ['admin', 'viewer'],
        });

        expect(roles).toContain('admin');
        expect(roles).toContain('viewer');
        expect(roles).toHaveLength(2);
        expect(getRoles({ roles: { editor: true, viewer: false } })).toEqual(['editor', 'viewer']);
    });

    test('filters non-string entries from role arrays', () => {
        expect(getRoles({ roles: ['admin', 123, null, 'viewer'] })).toEqual(['admin', 'viewer']);
    });
});
