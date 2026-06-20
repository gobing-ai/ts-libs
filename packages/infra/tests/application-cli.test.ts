import { afterEach, describe, expect, test } from 'bun:test';
import type { ApplicationRuntime } from '../src/application/types';
import { type CliApplicationOptions, runCliApplication } from '../src/application-cli';

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Swap `process.exit` and `process.stderr.write` so tests can capture the
 * exit code and stderr without terminating the runner. Returns restore().
 */
function captureExit(): { codes: number[]; stderr: string[]; restore: () => void } {
    const codes: number[] = [];
    const stderr: string[] = [];
    const origExit = process.exit;
    const origStderrWrite = process.stderr.write.bind(process.stderr);

    // `process.exit` is typed `(code?: number) => never`. In tests we never
    // actually terminate — we record and return. Cast keeps TS happy.
    process.exit = ((code?: number) => {
        codes.push(code ?? 0);
    }) as typeof process.exit;
    process.stderr.write = ((chunk: string) => {
        stderr.push(String(chunk));
        return true;
    }) as typeof process.stderr.write;

    return {
        codes,
        stderr,
        restore: () => {
            process.exit = origExit;
            process.stderr.write = origStderrWrite;
        },
    };
}

const baseOptions = {
    config: { logging: { console: false }, telemetry: { enabled: false }, events: { enabled: false } },
} satisfies Partial<CliApplicationOptions>;

afterEach(() => {
    // No global module resets needed — CLI bootstrap has no OTel/DB by default.
});

// ── Exit code mapping ─────────────────────────────────────────────────────

describe('runCliApplication — exit code mapping', () => {
    test('void start resolves to exit 0', async () => {
        const cap = captureExit();
        try {
            await runCliApplication({
                ...baseOptions,
                start: async () => {},
            });
            expect(cap.codes).toEqual([0]);
        } finally {
            cap.restore();
        }
    });

    test('numeric start return becomes the exit code', async () => {
        const cap = captureExit();
        try {
            await runCliApplication({
                ...baseOptions,
                start: async () => 42,
            });
            expect(cap.codes).toEqual([42]);
        } finally {
            cap.restore();
        }
    });

    test('exit code 0 is explicit', async () => {
        const cap = captureExit();
        try {
            await runCliApplication({
                ...baseOptions,
                start: async () => 0,
            });
            expect(cap.codes).toEqual([0]);
        } finally {
            cap.restore();
        }
    });
});

// ── Error boundary ────────────────────────────────────────────────────────

describe('runCliApplication — error boundary', () => {
    test('start throw → exit 1 + stderr message', async () => {
        const cap = captureExit();
        try {
            await runCliApplication({
                ...baseOptions,
                start: async () => {
                    throw new Error('boom');
                },
            });
            expect(cap.codes).toEqual([1]);
            expect(cap.stderr.join('')).toContain('Error: boom');
        } finally {
            cap.restore();
        }
    });

    test('non-Error throw → stringified to stderr', async () => {
        const cap = captureExit();
        try {
            await runCliApplication({
                ...baseOptions,
                start: async () => {
                    throw 'string error';
                },
            });
            expect(cap.codes).toEqual([1]);
            expect(cap.stderr.join('')).toContain('string error');
        } finally {
            cap.restore();
        }
    });
});

// ── Lifecycle callbacks ───────────────────────────────────────────────────

describe('runCliApplication — lifecycle callbacks', () => {
    test('stop callback runs with shutdown reason on success', async () => {
        const cap = captureExit();
        const reasons: string[] = [];
        try {
            await runCliApplication({
                ...baseOptions,
                stop: async (_app: ApplicationRuntime, reason) => {
                    reasons.push(reason);
                },
                start: async () => 0,
            });
            expect(cap.codes).toEqual([0]);
            expect(reasons).toContain('shutdown');
        } finally {
            cap.restore();
        }
    });

    test('stop callback runs with error reason when start throws', async () => {
        const cap = captureExit();
        const reasons: string[] = [];
        try {
            await runCliApplication({
                ...baseOptions,
                stop: async (_app: ApplicationRuntime, reason) => {
                    reasons.push(reason);
                },
                start: async () => {
                    throw new Error('fail');
                },
            });
            expect(cap.codes).toEqual([1]);
            // runApplication's catch calls stopAll('error') which invokes user stop.
            expect(reasons).toContain('error');
        } finally {
            cap.restore();
        }
    });

    test('logger is available in start callback', async () => {
        const cap = captureExit();
        let sawLogger = false;
        try {
            await runCliApplication({
                ...baseOptions,
                start: async (app) => {
                    sawLogger = typeof app.logger.info === 'function';
                },
            });
            expect(cap.codes).toEqual([0]);
            expect(sawLogger).toBe(true);
        } finally {
            cap.restore();
        }
    });
});

// ── Subprocess smoke test (real process.exit) ────────────────────────────

describe('runCliApplication — real process exit', () => {
    test('actual process exits with the start return code', async () => {
        const proc = Bun.spawn(
            [
                'bun',
                '-e',
                `
            import { runCliApplication } from '${import.meta.dir}/../src/application-cli.ts';
            await runCliApplication({
                config: { logging: { console: false }, telemetry: { enabled: false }, events: { enabled: false } },
                start: async () => 7,
            });
        `,
            ],
            { stdout: 'pipe', stderr: 'pipe' },
        );
        const [exitCode] = await Promise.all([proc.exited]);
        expect(exitCode).toBe(7);
    });

    test('actual process exits 1 on thrown start', async () => {
        const proc = Bun.spawn(
            [
                'bun',
                '-e',
                `
            import { runCliApplication } from '${import.meta.dir}/../src/application-cli.ts';
            await runCliApplication({
                config: { logging: { console: false }, telemetry: { enabled: false }, events: { enabled: false } },
                start: async () => { throw new Error('subprocess-fail'); },
            });
        `,
            ],
            { stdout: 'pipe', stderr: 'pipe' },
        );
        const exitCode = await proc.exited;
        expect(exitCode).toBe(1);
    });
});
