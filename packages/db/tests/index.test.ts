import { describe, expect, test } from 'bun:test';

import { getPackageName, packageName } from '../src/index.js';

describe('@gobing-ai/ts-db', () => {
    test('exposes package identity placeholder', () => {
        expect(getPackageName()).toBe('@gobing-ai/ts-db');
        expect(packageName).toBe('@gobing-ai/ts-db');
    });
});
