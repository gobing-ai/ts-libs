import { describe, expect, test } from 'bun:test';
import type { InboxMessage } from '@gobing-ai/ts-db/inbox';
import { formatMessage } from '../src';

const baseMessage: InboxMessage = {
    id: 'msg-1',
    fromId: 'planner',
    toId: 'coder',
    body: 'hello',
    status: 'queued',
    inReplyTo: null,
    createdAt: 0,
    updatedAt: 0,
    deliveredAt: null,
    injectAttempts: 0,
    injectError: null,
};

describe('formatMessage', () => {
    test('labels the sender by id', () => {
        expect(formatMessage(baseMessage)).toBe('[task from=planner id=msg-1] hello');
    });

    test('falls back to operator when fromId is null', () => {
        expect(formatMessage({ ...baseMessage, fromId: null })).toBe('[task from=operator id=msg-1] hello');
    });
});
