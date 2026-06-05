import { describe, expect, test } from 'bun:test';

import { DBJobQueue, DBQueueConsumer } from '../src/job-queue-db';

describe('job-queue-db subpath source entry', () => {
    test('exports DB-backed queue adapters', () => {
        expect(DBJobQueue).toBeDefined();
        expect(DBQueueConsumer).toBeDefined();
    });
});
