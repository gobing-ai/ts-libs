import { describe, expect, test } from 'bun:test';

import { getPackageName, packageName } from '../src/index';

describe('@gobing-ai/ts-infra', () => {
    test('exposes package identity placeholder', () => {
        expect(getPackageName()).toBe('@gobing-ai/ts-infra');
        expect(packageName).toBe('@gobing-ai/ts-infra');
    });
});
