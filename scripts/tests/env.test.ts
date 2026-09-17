import { afterEach, describe, expect, test } from 'bun:test';

import { getEnvVar, removeEnvVar, setEnvVar } from '../lib/env';

describe('scripts env mirror', () => {
    afterEach(() => removeEnvVar('ROBB_MIRROR_TEST'));

    test('getEnvVar returns set value, falls back when unset', () => {
        setEnvVar('ROBB_MIRROR_TEST', 'v');
        expect(getEnvVar('ROBB_MIRROR_TEST', 'fb')).toBe('v');
        removeEnvVar('ROBB_MIRROR_TEST');
        expect(getEnvVar('ROBB_MIRROR_TEST', 'fb')).toBe('fb');
    });

    test('setEnvVar(undefined) removes the key', () => {
        setEnvVar('ROBB_MIRROR_TEST', 'v');
        setEnvVar('ROBB_MIRROR_TEST', undefined);
        expect(getEnvVar('ROBB_MIRROR_TEST')).toBeUndefined();
    });
});
