import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { createNodeFileSystem, joinPath } from '@gobing-ai/ts-runtime';
import { AiRunner } from '../src/ai-runner';

/**
 * R9: the live probe runs only on a capable host — darwin with the system
 * model available. Everywhere else this suite skips with a stated reason and
 * never fails because the host lacks fm (AC6: Linux CI passes without fm).
 */
async function fmSystemModelAvailable(): Promise<boolean> {
    try {
        const result = await new AiRunner().runAuthCommand('fm');
        return result !== null && result.exitCode === 0;
    } catch {
        return false; // fm absent / spawn failed — not a capable host.
    }
}

const fmReady = process.platform === 'darwin' && (await fmSystemModelAvailable());

describe('fm live session (task 0083 R9 — skipped unless darwin with the system model available)', () => {
    test.skipIf(!fmReady)('a second prompt in the same session recalls the first', async () => {
        const sessionDir = joinPath(tmpdir(), `ts-libs-fm-live-${Date.now()}`);
        await createNodeFileSystem().ensureDir(sessionDir);
        const runner = new AiRunner();

        // First prompt: fresh open — sessionDir only saves <dir>/fm-session.json
        // (feature K R4 scenario: a sessionId with no transcript fails the run).
        const first = await runner.runPromptCommand(
            'fm',
            { sessionDir, input: 'Remember this codeword: BANANA42. Reply with exactly: OK' },
            { timeout: 120_000 },
        );
        expect(first.exitCode).toBe(0);

        // Second prompt: sessionId 'fm-session' resolves to the saved transcript
        // and resumes it (`--resume <f> --save-transcript <f>`).
        const second = await runner.runPromptCommand(
            'fm',
            {
                sessionDir,
                sessionId: 'fm-session',
                input: 'What was the codeword? Reply with exactly the codeword and nothing else.',
            },
            { timeout: 120_000 },
        );
        expect(second.exitCode).toBe(0);
        expect(second.stdout).toContain('BANANA42');
    });
});
