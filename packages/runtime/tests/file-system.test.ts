import { describe, expect, test } from 'bun:test';
import type { FileSystem } from '../src/file-system';

describe('FileSystem type', () => {
    test('is importable as a type', () => {
        const fs: FileSystem = {} as FileSystem;
        expect(fs).toBeDefined();
    });
});
