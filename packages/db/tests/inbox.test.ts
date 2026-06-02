import { describe, expect, test } from 'bun:test';
import * as inbox from '../src/inbox';

describe('@gobing-ai/ts-db/inbox subpath', () => {
    test('exports inbox DAO, row type surface, and schema table', () => {
        expect(inbox.InboxMessageDao).toBeDefined();
        expect(inbox.inboxMessages).toBeDefined();
    });
});
