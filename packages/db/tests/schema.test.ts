import { describe, expect, test } from 'bun:test';
import {
    appendOnlyColumns,
    buildAppendOnlyColumns,
    buildStandardColumns,
    buildStandardColumnsWithSoftDelete,
    nowTimestamp,
    standardColumns,
    standardColumnsWithSoftDelete,
} from '../src/schema/common';
import { queueJobs } from '../src/schema/queue-jobs';

describe('schema/common', () => {
    test('nowTimestamp returns a number', () => {
        const ts = nowTimestamp();
        expect(typeof ts).toBe('number');
        expect(ts).toBeGreaterThan(0);
    });

    test('buildStandardColumns returns createdAt and updatedAt', () => {
        const cols = buildStandardColumns();
        expect(cols.createdAt).toBeDefined();
        expect(cols.updatedAt).toBeDefined();
    });

    test('standardColumns is pre-built', () => {
        expect(standardColumns.createdAt).toBeDefined();
        expect(standardColumns.updatedAt).toBeDefined();
    });

    test('buildStandardColumnsWithSoftDelete includes inUsed', () => {
        const cols = buildStandardColumnsWithSoftDelete();
        expect(cols.inUsed).toBeDefined();
    });

    test('standardColumnsWithSoftDelete includes inUsed', () => {
        expect(standardColumnsWithSoftDelete.inUsed).toBeDefined();
    });

    test('buildAppendOnlyColumns has createdAt but not updatedAt', () => {
        const cols = buildAppendOnlyColumns();
        expect(cols.createdAt).toBeDefined();
        expect('updatedAt' in cols).toBeFalse();
    });

    test('appendOnlyColumns is pre-built', () => {
        expect(appendOnlyColumns.createdAt).toBeDefined();
    });
});

describe('schema/queueJobs', () => {
    test('queueJobs has standard columns', () => {
        expect(queueJobs.id).toBeDefined();
        expect(queueJobs.type).toBeDefined();
        expect(queueJobs.status).toBeDefined();
        expect(queueJobs.attempts).toBeDefined();
        expect(queueJobs.maxRetries).toBeDefined();
        expect(queueJobs.createdAt).toBeDefined();
        expect(queueJobs.updatedAt).toBeDefined();
    });
});
