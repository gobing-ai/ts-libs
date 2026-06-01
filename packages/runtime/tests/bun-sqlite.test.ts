import { describe, expect, test } from 'bun:test';
import { Database } from '../src/bun-sqlite';

describe('bun-sqlite runtime subpath', () => {
    test('exports bun:sqlite Database for Bun-only consumers', () => {
        expect(Database).toBeDefined();
    });
});
