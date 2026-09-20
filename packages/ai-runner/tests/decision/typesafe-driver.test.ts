import { describe, expect, test } from 'bun:test';
import { createTypesafeDriver } from '../../src/decision/typesafe-driver';

describe('createTypesafeDriver', () => {
    test('construction is not wired until task 0072 delivers the client', () => {
        expect(() => createTypesafeDriver({ apiKey: 'k' })).toThrow('task 0072');
    });
});
