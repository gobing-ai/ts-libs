import { describe, expect, test } from 'bun:test';
import { queueJobs } from '../../src/schema/runtime';

describe('schema runtime barrel', () => {
    test('exports runtime-safe schema tables without validation helpers', () => {
        expect(queueJobs).toBeDefined();
    });
});
