import { describe, expect, test } from 'bun:test';

import * as db from '../src/index';

describe('@gobing-ai/ts-db barrel', () => {
    test('exports adapter symbols', () => {
        expect(db.createDbAdapter).toBeDefined();
        expect(db.BunSqliteAdapter).toBeDefined();
        expect(db.D1Adapter).toBeDefined();
    });

    test('exports DAO symbols', () => {
        expect(db.BaseDao).toBeDefined();
        expect(db.EntityDao).toBeDefined();
        expect(db.QueueJobDao).toBeDefined();
    });

    test('exports schema symbols', () => {
        expect(db.queueJobs).toBeDefined();
        expect(db.standardColumns).toBeDefined();
        expect(db.standardColumnsWithSoftDelete).toBeDefined();
        expect(db.appendOnlyColumns).toBeDefined();
        expect(db.buildStandardColumns).toBeDefined();
        expect(db.buildStandardColumnsWithSoftDelete).toBeDefined();
        expect(db.buildAppendOnlyColumns).toBeDefined();
        expect(db.nowTimestamp).toBeDefined();
    });

    test('exports migration symbols', () => {
        expect(db.applyMigrations).toBeDefined();
        expect(db.embeddedMigrations).toBeDefined();
    });
});
