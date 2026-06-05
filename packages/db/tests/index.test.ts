import { describe, expect, test } from 'bun:test';

import * as db from '../src/index';

describe('@gobing-ai/ts-db barrel', () => {
    test('exports adapter symbols', () => {
        expect(db.createDbAdapter).toBeDefined();
        expect(db.D1Adapter).toBeDefined();
    });

    test('exports DAO symbols', () => {
        expect(db.BaseDao).toBeDefined();
        expect(db.EntityDao).toBeDefined();
        expect(db.InboxMessageDao).toBeDefined();
        expect(db.QueueJobDao).toBeDefined();
    });

    test('keeps schema helpers out of the main barrel', () => {
        expect('inboxMessages' in db).toBe(false);
        expect('queueJobs' in db).toBe(false);
        expect('standardColumns' in db).toBe(false);
        expect('defineTable' in db).toBe(false);
    });

    test('exports migration symbols', () => {
        expect(db.applyMigrations).toBeDefined();
        expect(db.embeddedMigrations).toBeDefined();
    });
});
