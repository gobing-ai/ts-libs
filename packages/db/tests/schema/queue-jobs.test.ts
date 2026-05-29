import { describe, expect, test } from 'bun:test';
import { queueJobs } from '../../src/schema/queue-jobs';

describe('schema/queueJobs', () => {
    test('queueJobs has standard columns', () => {
        expect(queueJobs.id).toBeDefined();
        expect(queueJobs.type).toBeDefined();
        expect(queueJobs.status).toBeDefined();
        expect(queueJobs.attempts).toBeDefined();
        expect(queueJobs.maxRetries).toBeDefined();
        expect(queueJobs.createdAt).toBeDefined();
        expect(queueJobs.updatedAt).toBeDefined();
    });
});
