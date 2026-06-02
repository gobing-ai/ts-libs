import { describe, expect, test } from 'bun:test';
import type {
    CountSelectDb,
    InsertBuilder,
    ReturningRows,
    SelectOrderedLimitDb,
    SelectProjectionDb,
    UpdateChangesDb,
    UpdateReturningDb,
    UpdateVoidDb,
} from '../src/drizzle-builders';

// `drizzle-builders` is type-only: it names the fluent-builder shapes the DAOs
// narrow `InternalDb` to. There is no runtime to exercise, so these tests verify
// the structural contracts hold at compile time — a shape that drifts from what
// the DAOs actually call would fail typecheck here, in one place.

describe('drizzle-builders structural contracts', () => {
    test('builder shapes accept conforming fluent chains', () => {
        const returning: ReturningRows = { returning: async () => [] };

        const insert: InsertBuilder = {
            values: () => ({
                ...returning,
                onConflictDoUpdate: () => returning,
            }),
        };

        const updateReturning: UpdateReturningDb = {
            update: () => ({ set: () => ({ where: () => returning }) }),
        };

        const updateVoid: UpdateVoidDb = {
            update: () => ({ set: () => ({ where: async () => undefined }) }),
        };

        const updateChanges: UpdateChangesDb = {
            update: () => ({ set: () => ({ where: async () => ({ changes: 0 }) }) }),
        };

        const selectProjection: SelectProjectionDb = {
            select: () => ({ from: () => ({ where: async () => [], groupBy: async () => [] }) }),
        };

        const selectOrdered: SelectOrderedLimitDb = {
            select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }),
        };

        const countSelect: CountSelectDb = {
            select: () => ({ from: () => Object.assign(Promise.resolve([]), { where: async () => [] }) }),
        };

        // Touch each binding so the type-checked construction is the assertion.
        expect([
            insert,
            updateReturning,
            updateVoid,
            updateChanges,
            selectProjection,
            selectOrdered,
            countSelect,
        ]).toHaveLength(7);
    });
});
