import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';
import { spawnSync } from 'node:child_process';

export interface CommandResult {
    ok: boolean;
    status: number | null;
    stdout: string;
    stderr: string;
}

export type Spawn = typeof spawnSync;

export function runCommand(
    command: string,
    args: string[],
    options: SpawnSyncOptions = {},
    spawn: Spawn = spawnSync,
): CommandResult {
    const result = spawn(command, args, {
        encoding: 'utf-8',
        ...options,
    }) as SpawnSyncReturns<string>;

    return {
        ok: result.status === 0,
        status: result.status,
        stdout: (result.stdout ?? '').trim(),
        stderr: (result.stderr ?? '').trim(),
    };
}
