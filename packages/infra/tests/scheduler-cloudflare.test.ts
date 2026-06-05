import { describe, expect, test } from 'bun:test';

import { CloudflareSchedulerAdapter } from '../src/scheduler-cloudflare';

describe('scheduler-cloudflare subpath source entry', () => {
    test('exports Cloudflare scheduler adapter', () => {
        expect(CloudflareSchedulerAdapter).toBeDefined();
    });
});
