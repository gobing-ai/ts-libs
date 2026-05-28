import { describe, expect, test } from 'bun:test';

import { getPackageName, packageName } from '../src/index.js';

describe('@gobing-ai/ts-utils', () => {
    test('exposes package identity placeholder', () => {
        expect(getPackageName()).toBe('@gobing-ai/ts-utils');
        expect(packageName).toBe('@gobing-ai/ts-utils');
    });
});
