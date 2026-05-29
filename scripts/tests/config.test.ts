import { describe, expect, test } from 'bun:test';
import { buildConfig, releaseConfig, SEMVER } from '../config';

describe('script config', () => {
    test('formats release messages from central config', () => {
        expect(releaseConfig.releaseCommitSubject('0.1.6')).toBe('bump all packages to 0.1.6');
        expect(releaseConfig.releaseTagMessage('@gobing-ai/ts-utils-v0.1.6')).toBe(
            'release: @gobing-ai/ts-utils-v0.1.6',
        );
    });

    test('keeps smoke import package sets explicit', () => {
        expect(buildConfig.nodeSmokePackages).toContain('@gobing-ai/ts-utils');
        expect(buildConfig.bunSmokePackages).toContain('@gobing-ai/ts-infra');
    });

    test('validates semver strings', () => {
        expect(SEMVER.test('0.1.6')).toBe(true);
        expect(SEMVER.test('0.1')).toBe(false);
    });
});
