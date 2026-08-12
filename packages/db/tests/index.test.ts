import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import * as db from '../src/index';

describe('@gobing-ai/ts-db barrel', () => {
    test('exports adapter symbols', () => {
        expect(db.createDbAdapter).toBeDefined();
    });

    test('does not statically export D1Adapter — subpath only (0060 C1, ADR-005 addendum)', () => {
        // The main barrel must not value-export adapter classes: `D1Adapter` would pull
        // drizzle-orm/d1 into every consumer at import time. It lives on @gobing-ai/ts-db/d1.
        expect('D1Adapter' in db).toBe(false);
        const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
        expect(source).not.toContain('./adapters/d1');
        // The factory path stays dynamic (adapter.ts) — no static import of the d1 dialect.
        expect(source).not.toContain('adapters/d1');
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
