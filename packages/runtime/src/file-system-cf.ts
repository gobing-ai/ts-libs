/**
 * Cloudflare Workers {@link FileSystem} stub.
 *
 * CF Workers have only an ephemeral, per-request virtual filesystem.
 * Persistent file operations are not available. This stub throws clear
 * errors directing developers to use D1, KV, or R2 instead.
 *
 * Non-mutating operations (`resolve`, `getProjectRoot`) return
 * Worker-appropriate values without throwing.
 *
 * Note: Cloudflare Workers with `nodejs_compat` + `compatibility_date >= 2025-09-01`
 * DO expose `node:fs` as an ephemeral, per-request virtual filesystem.
 * We deliberately do NOT use it — the ephemeral nature means files written
 * in one request silently vanish in the next. Throwing with guidance toward
 * D1/KV/R2 is better DX than silent data loss.
 */

import type { FileSystem } from './file-system';

const UNSUPPORTED = 'FileSystem is not available on Cloudflare Workers. Use D1, KV, or R2 for persistent storage.';

/**
 * Create a Cloudflare Workers {@link FileSystem} stub.
 *
 * `resolve()` and `getProjectRoot()` work as path utilities.
 * All other methods throw with guidance toward CF-native storage.
 */
export function createCfFileSystem(): FileSystem {
    return {
        getProjectRoot: () => '/bundle',

        resolve: (...segments: string[]) => {
            const joined = segments.join('/').replaceAll(/\/+/g, '/');
            return joined.startsWith('/') ? joined : `/${joined}`;
        },

        exists: (_path: string) => false,

        readFile: (_path: string): never => {
            throw new Error(`FileSystem.readFile: ${UNSUPPORTED}`);
        },

        writeFile: (_path: string, _content: string): never => {
            throw new Error(`FileSystem.writeFile: ${UNSUPPORTED}`);
        },

        appendFile: (_path: string, _content: string): never => {
            throw new Error(`FileSystem.appendFile: ${UNSUPPORTED}`);
        },

        ensureDir: (_path: string): void => {
            // No-op: CF Workers virtual filesystem handles directory
            // creation internally when files are written.
        },

        readDir: (_path: string): never => {
            throw new Error(`FileSystem.readDir: ${UNSUPPORTED}`);
        },

        deleteFile: (_path: string): never => {
            throw new Error(`FileSystem.deleteFile: ${UNSUPPORTED}`);
        },

        createWriteStream: (_path: string): never => {
            throw new Error(`FileSystem.createWriteStream: ${UNSUPPORTED}`);
        },

        copy: (_src: string, _dest: string): never => {
            throw new Error(`FileSystem.copy: ${UNSUPPORTED}`);
        },

        stat: (_path: string) => null,
    };
}
