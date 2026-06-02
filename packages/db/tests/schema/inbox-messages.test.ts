import { describe, expect, test } from 'bun:test';
import { inboxMessages } from '../../src/schema/inbox-messages';

describe('schema/inboxMessages', () => {
    test('inboxMessages has durable message columns', () => {
        expect(inboxMessages.id).toBeDefined();
        expect(inboxMessages.fromId).toBeDefined();
        expect(inboxMessages.toId).toBeDefined();
        expect(inboxMessages.body).toBeDefined();
        expect(inboxMessages.status).toBeDefined();
        expect(inboxMessages.inReplyTo).toBeDefined();
        expect(inboxMessages.createdAt).toBeDefined();
        expect(inboxMessages.updatedAt).toBeDefined();
        expect(inboxMessages.deliveredAt).toBeDefined();
        expect(inboxMessages.injectAttempts).toBeDefined();
        expect(inboxMessages.injectError).toBeDefined();
    });
});
