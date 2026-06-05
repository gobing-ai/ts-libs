import { describe, expect, test } from 'bun:test';

import { NodeSchedulerAdapter } from '../src/scheduler-node';

describe('scheduler-node subpath source entry', () => {
    test('exports Node scheduler adapter', () => {
        expect(NodeSchedulerAdapter).toBeDefined();
    });
});
