import { describe, expect, test } from 'bun:test';
import { createCfFileSystem } from '../src/file-system-cf';

describe('createCfFileSystem', () => {
    test('getProjectRoot returns /bundle', () => {
        const fs = createCfFileSystem();
        expect(fs.getProjectRoot()).toBe('/bundle');
    });

    test('resolve joins path segments', () => {
        const fs = createCfFileSystem();
        expect(fs.resolve('config', 'app.yaml')).toBe('/config/app.yaml');
    });

    test('exists always returns false', () => {
        expect(createCfFileSystem().exists('/anything')).toBe(false);
    });

    test('readFile throws', () => {
        expect(() => createCfFileSystem().readFile('/x')).toThrow('D1, KV, or R2');
    });

    test('writeFile throws', () => {
        expect(() => createCfFileSystem().writeFile('/x', 'c')).toThrow('D1, KV, or R2');
    });

    test('stat returns null', () => {
        expect(createCfFileSystem().stat('/x')).toBeNull();
    });

    test('appendFile throws', () => {
        expect(() => createCfFileSystem().appendFile('/x', 'c')).toThrow('D1, KV, or R2');
    });

    test('ensureDir is noop', () => {
        const fs = createCfFileSystem();
        expect(() => fs.ensureDir('/dir')).not.toThrow();
    });

    test('readDir throws', () => {
        expect(() => createCfFileSystem().readDir('/x')).toThrow('D1, KV, or R2');
    });

    test('deleteFile throws', () => {
        expect(() => createCfFileSystem().deleteFile('/x')).toThrow('D1, KV, or R2');
    });

    test('createWriteStream throws', () => {
        expect(() => createCfFileSystem().createWriteStream('/x')).toThrow('D1, KV, or R2');
    });

    test('copy throws', () => {
        expect(() => createCfFileSystem().copy('/src', '/dest')).toThrow('D1, KV, or R2');
    });
});
