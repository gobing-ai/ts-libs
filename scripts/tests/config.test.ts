import { describe, expect, test } from 'bun:test';
import { buildConfig, releaseConfig, SEMVER } from '../config';

describe('script config', () => {
    test('formats release messages from central config', () => {
        expect(releaseConfig.aggregatePackageName).toBe('@gobing-ai/ts-libs');
        expect(releaseConfig.releaseCommitSubject('0.1.6')).toBe('bump all packages to 0.1.6');
        expect(releaseConfig.releaseTagMessage('@gobing-ai/ts-utils-v0.1.6')).toBe(
            'release: @gobing-ai/ts-utils-v0.1.6',
        );
    });

    test('keeps Node smoke import packages explicit', () => {
        expect(buildConfig.nodeSmokePackages).toEqual([]);
    });

    test('validates semver strings', () => {
        expect(SEMVER.test('0.1.6')).toBe(true);
        expect(SEMVER.test('0.1')).toBe(false);
    });
});
