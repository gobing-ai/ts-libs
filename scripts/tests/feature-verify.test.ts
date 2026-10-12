import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('feature verification adapter delegates identity and propagates operation errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ts-libs-feature-verify-'));
    const modulePath = join(root, 'verification.mjs');
    const driver = join(import.meta.dir, '../../.spur/scripts/feature-verify.mjs');
    try {
        await writeFile(
            modulePath,
            `export async function runFeatureVerification(input) {
                if (input.featureId === 'unsafe') throw new Error('refusing unsafe feature id');
                return { message: JSON.stringify(input) };
            }`,
        );
        const run = (featureId: string) =>
            spawnSync(
                process.execPath,
                [driver, 'verify', '--feature-id', featureId, '--run-id', 'test-run', '--spur-module', modulePath],
                {
                    cwd: root,
                    encoding: 'utf8',
                },
            );
        const success = run('F1');
        expect(success.status).toBe(0);
        expect(JSON.parse(success.stdout.slice(success.stdout.indexOf('{')))).toEqual({
            workdir: await realpath(root),
            featureId: 'F1',
            runId: 'test-run',
        });
        const failed = run('unsafe');
        expect(failed.status).toBe(1);
        expect(failed.stderr).toContain('refusing unsafe feature id');
        await writeFile(modulePath, 'export const obsolete = true;');
        const stale = run('F1');
        expect(stale.status).toBe(1);
        expect(stale.stderr).toContain('missing runFeatureVerification');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
