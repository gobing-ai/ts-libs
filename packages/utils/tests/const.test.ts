import { describe, expect, test } from 'bun:test';

import { LOG_CATEGORY_APP, LOG_CATEGORY_CLI } from '../src/const';

describe('log category constants', () => {
    test('exports application and CLI categories without a log file path constant', async () => {
        const constants = await import('../src/const');

        expect(LOG_CATEGORY_APP).toBe('app');
        expect(LOG_CATEGORY_CLI).toBe('cli');
        expect('LOG_FILE_PATH' in constants).toBe(false);
    });
});
