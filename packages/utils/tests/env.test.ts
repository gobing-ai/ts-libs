import { afterEach, describe, expect, test } from 'bun:test';

import { getAppOptions, getEnvVar, getEnvVars, removeEnvVar, setEnvVar } from '../src/env';

describe('env gateway', () => {
    const KEYS = ['TS_UTILS_TEST_VAR', 'TS_UTILS_TEST_RESTORE'];
    afterEach(() => {
        for (const key of KEYS) removeEnvVar(key);
    });

    test('getEnvVar returns set value; empty string is set, unset yields fallback', () => {
        setEnvVar('TS_UTILS_TEST_VAR', '');
        expect(getEnvVar('TS_UTILS_TEST_VAR', 'fb')).toBe('');
        removeEnvVar('TS_UTILS_TEST_VAR');
        expect(getEnvVar('TS_UTILS_TEST_VAR', 'fb')).toBe('fb');
        expect(getEnvVar('TS_UTILS_TEST_VAR')).toBeUndefined();
    });

    test('setEnvVar(undefined) removes; removeEnvVar is a no-op on absent keys', () => {
        setEnvVar('TS_UTILS_TEST_VAR', 'v');
        setEnvVar('TS_UTILS_TEST_VAR', undefined);
        expect('TS_UTILS_TEST_VAR' in getEnvVars()).toBe(false);
        removeEnvVar('TS_UTILS_TEST_VAR');
        expect('TS_UTILS_TEST_VAR' in getEnvVars()).toBe(false);
    });

    test('getEnvVars is the live environment record, not a copy', () => {
        setEnvVar('TS_UTILS_TEST_VAR', 'live');
        expect(getEnvVars().TS_UTILS_TEST_VAR).toBe('live');
    });

    test('getAppOptions falls back on null config, null section, null value', () => {
        expect(getAppOptions(null, 'k', 'd')).toBe('d');
        expect(getAppOptions({}, 'k', 'd')).toBe('d');
        expect(getAppOptions({ bootstrap: { options: null } }, 'k', 'd')).toBe('d');
        expect(getAppOptions({ bootstrap: { options: { k: null } } }, 'k', 'd')).toBe('d');
        expect(getAppOptions<number>({ bootstrap: { options: { k: 42 } } }, 'k', 0)).toBe(42);
    });
});
