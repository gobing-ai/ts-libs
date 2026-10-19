import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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

test('the adapter records a derived confidence level on the receipt it did not write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ts-libs-feature-verify-confidence-'));
    const modulePath = join(root, 'verification.mjs');
    const driver = join(import.meta.dir, '../../.spur/scripts/feature-verify.mjs');
    const evidenceDir = join(root, '.spur', 'memory', 'evidence');
    const receiptPath = join(evidenceDir, 'F1-feature-verification.json');

    /** A seam double that writes the receipt shape spur writes and completes with `status`. */
    const seam = (status: string) =>
        `import { mkdirSync, writeFileSync } from 'node:fs';
         export async function runFeatureVerification(input) {
             mkdirSync(${JSON.stringify(evidenceDir)}, { recursive: true });
             writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({
                 schemaVersion: 1, featureId: input.featureId, runId: input.runId, workdir: input.workdir,
                 verifier: { name: 'feature-verification', sourcePath: 'x', layer: 'project', definitionDigest: 'd' },
                 verificationCmd: input.cmdOverride ?? 'spur self exec check-feature',
                 inputDigest: 'sha256:aaaa', status: ${JSON.stringify(status)},
                 startedAt: '2026-10-19T10:00:00Z', completedAt: '2026-10-19T10:01:00Z' }, null, 4));
             return { message: 'verification ' + ${JSON.stringify(status)} };
         }`;

    const run = (extra: string[] = []) =>
        spawnSync(
            process.execPath,
            [driver, 'verify', '--feature-id', 'F1', '--run-id', 'test-run', '--spur-module', modulePath, ...extra],
            {
                cwd: root,
                encoding: 'utf8',
            },
        );
    const receipt = async () => JSON.parse(await readFile(receiptPath, 'utf8'));

    try {
        // The seam's own default (the definition's gate) earns HIGH without an injected override.
        await writeFile(modulePath, seam('PASS'));
        expect(run().status).toBe(0);
        expect(await receipt()).toMatchObject({
            confidenceContract: 1,
            confidence: 'HIGH',
            confidenceBasis: 'full project gate: spur self exec check-feature',
        });

        // A narrowed command proves less, whatever its exit code.
        await writeFile(modulePath, seam('PASS'));
        expect(run(['--cmd', 'bun test packages/ai-decision']).status).toBe(0);
        expect(await receipt()).toMatchObject({
            confidence: 'MEDIUM',
            confidenceBasis: 'narrowed command cannot prove more than its own checks: bun test packages/ai-decision',
        });

        // A pass that did not pass certifies nothing.
        await writeFile(modulePath, seam('FAIL'));
        expect(run().status).toBe(0);
        expect(await receipt()).toMatchObject({ confidence: 'LOW' });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
