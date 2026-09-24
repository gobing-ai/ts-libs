import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { ownProcessGroupLifecycle, resolveDeadline, resolveKillGraceMs } from '../src/process-group';

describe('resolveDeadline / resolveKillGraceMs (task 0087 R8)', () => {
    test('option timeout wins over the default; null is unlimited; undefined inherits', () => {
        expect(resolveDeadline(500, 1000)).toBe(500);
        expect(resolveDeadline(undefined, 1000)).toBe(1000);
        expect(resolveDeadline(null, 1000)).toBeNull();
        expect(resolveDeadline(undefined, undefined)).toBeUndefined();
    });

    test('invalid timeouts throw TypeError before any spawn', () => {
        for (const bad of [0, -1, 1.5, Number.NaN, 2_147_483_648]) {
            expect(() => resolveDeadline(bad, undefined)).toThrow(TypeError);
        }
    });

    test('kill grace defaults to 5000 and validates non-negative integers', () => {
        expect(resolveKillGraceMs(undefined)).toBe(5000);
        expect(resolveKillGraceMs(0)).toBe(0);
        for (const bad of [-1, 0.5, Number.NaN]) {
            expect(() => resolveKillGraceMs(bad)).toThrow(TypeError);
        }
    });
});

describe('ownProcessGroupLifecycle (task 0087 R8, Unix only)', () => {
    test('a deadline reaps the detached process group, and stop() is callable after settle', async () => {
        if (process.platform === 'win32') return;
        const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
        child.unref();
        const pid = child.pid;
        if (pid === undefined) throw new Error('spawn did not return a pid');
        expect(pid).toBeGreaterThan(0);
        const ownership = ownProcessGroupLifecycle({ pid, deadlineMs: 100, signal: undefined, graceMs: 100 });
        // finish() settles AFTER the executor's own path fired (mirrors the production call
        // order: execa promise settles first, then ownership.finish()).
        await new Promise((resolve) => setTimeout(resolve, 150));
        const outcome = await ownership.finish();
        expect(outcome).toBe('timeout');
        ownership.stop();
        // The whole group is gone: a signal-0 probe on the group id fails with ESRCH.
        expect(() => process.kill(-pid, 0)).toThrow();
    });
});
