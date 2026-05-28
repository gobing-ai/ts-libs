import { describe, expect, test } from 'bun:test';

import { getPackageName, packageName } from '../src/index';

describe('@gobing-ai/ts-runtime', () => {
    test('exposes package identity placeholder', () => {
        expect(getPackageName()).toBe('@gobing-ai/ts-runtime');
        expect(packageName).toBe('@gobing-ai/ts-runtime');
    });
});
