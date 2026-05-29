import { describe, expect, test } from 'bun:test';
import type { spawnSync } from 'node:child_process';
import { runCommand } from '../lib/command';

describe('runCommand', () => {
    test('normalizes successful command output', () => {
        const spawn = (() => ({ status: 0, stdout: ' ok \n', stderr: '' })) as typeof spawnSync;

        expect(runCommand('tool', ['arg'], {}, spawn)).toEqual({
            ok: true,
            status: 0,
            stdout: 'ok',
            stderr: '',
        });
    });

    test('normalizes failed command output', () => {
        const spawn = (() => ({ status: 2, stdout: '', stderr: ' failed \n' })) as typeof spawnSync;

        expect(runCommand('tool', ['arg'], {}, spawn)).toEqual({
            ok: false,
            status: 2,
            stdout: '',
            stderr: 'failed',
        });
    });
});
