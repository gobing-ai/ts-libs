import { describe, expect, test } from 'bun:test';
import { HistoryImportError } from '../src';

describe('HistoryImportError', () => {
    test('carries name, message, and optional details', () => {
        const error = new HistoryImportError('invalid table', { table: 'unsafe' });

        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(HistoryImportError);
        expect(error.name).toBe('HistoryImportError');
        expect(error.message).toBe('invalid table');
        expect(error.details).toEqual({ table: 'unsafe' });
    });
});
