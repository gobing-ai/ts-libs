import { describe, expect, test } from 'bun:test';
import pkg from '../package.json';
import { sha256 } from '../src/hash';
import { HISTORY_IMPORT_SCHEMA_SQL, HISTORY_IMPORT_SCHEMA_VERSION } from '../src/schema-sql';

/**
 * Pinned hashes of HISTORY_IMPORT_SCHEMA_SQL by schema version.
 *
 * Task 0748 R1: whenever HISTORY_IMPORT_SCHEMA_SQL changes, HISTORY_IMPORT_SCHEMA_VERSION
 * MUST be bumped and the new version and its SQL hash recorded here.
 */
const KNOWN_SCHEMA_HASHES: Readonly<Record<string, string>> = {
    '0.4.55': 'bd0fa9887415ab40e5c3c82afa23535f9ad34cad61fce72c74179ad7104964a5',
    '0.4.56': '55b98f429f806219de417976dd9196a16b2f0629f3e13335b065a42f58faf13e',
};

describe('HISTORY_IMPORT_SCHEMA_VERSION (0748 R1)', () => {
    test('matches the package version in package.json', () => {
        expect(HISTORY_IMPORT_SCHEMA_VERSION).toBe(pkg.version);
    });

    test('hash of HISTORY_IMPORT_SCHEMA_SQL matches the pinned hash for this version', () => {
        const currentHash = sha256(HISTORY_IMPORT_SCHEMA_SQL);
        const expectedHash = KNOWN_SCHEMA_HASHES[HISTORY_IMPORT_SCHEMA_VERSION];

        expect(expectedHash).toBeDefined();
        expect(currentHash).toBe(expectedHash ?? '');
    });

    test('fails if schema SQL changes without version bump', () => {
        const modifiedSql = `${HISTORY_IMPORT_SCHEMA_SQL}\n-- modified`;
        const modifiedHash = sha256(modifiedSql);
        expect(modifiedHash).not.toBe(KNOWN_SCHEMA_HASHES[HISTORY_IMPORT_SCHEMA_VERSION]);
    });
});
