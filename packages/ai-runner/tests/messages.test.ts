import { describe, expect, test } from 'bun:test';
import type { DrainedMessage } from '../src';
import { formatMessage } from '../src';

const baseMessage: DrainedMessage = {
    id: 'msg-1',
    fromId: 'planner',
    body: 'hello',
};

describe('formatMessage', () => {
    test('labels the sender by id', () => {
        expect(formatMessage(baseMessage)).toBe('[task from=planner id=msg-1] hello');
    });

    test('falls back to operator when fromId is null', () => {
        expect(formatMessage({ ...baseMessage, fromId: null })).toBe('[task from=operator id=msg-1] hello');
    });
});
