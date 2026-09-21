import { describe, expect, it } from 'bun:test';
import {
    DecisionAuthError,
    DecisionBackendError,
    DecisionConfigError,
    DecisionConnectionError,
    DecisionError,
    DecisionRequestError,
    DecisionTimeoutError,
} from '@gobing-ai/ts-ai-runner';
import {
    LayaWorkerClient,
    translateWorkerError,
    validateHostPrerequisites,
    type WorkerQuestion,
} from '../src/worker-client';

function q(instructions: string): WorkerQuestion {
    // Choice criteria must satisfy the runtime contract the stub now mirrors.
    return { type: 'choice', instructions, criteria: ['x'] };
}

describe('Host prerequisites and decision taxonomy (task 0077)', () => {
    describe('R1, AC3 — platform validation at construction', () => {
        it('refuses an unsupported OS before spawning any process', () => {
            expect(() => validateHostPrerequisites('linux', 'arm64')).toThrow(DecisionConfigError);
            expect(() => validateHostPrerequisites('win32', 'arm64')).toThrow(DecisionConfigError);
            try {
                validateHostPrerequisites('linux', 'arm64');
            } catch (err) {
                expect(err).toBeInstanceOf(DecisionConfigError);
                expect((err as DecisionConfigError).variable).toBe('PLATFORM');
                expect((err as DecisionConfigError).message).toContain('darwin arm64');
            }
        });

        it('refuses an unsupported CPU architecture before spawning any process', () => {
            expect(() => validateHostPrerequisites('darwin', 'x64')).toThrow(DecisionConfigError);
            try {
                validateHostPrerequisites('darwin', 'x64');
            } catch (err) {
                expect(err).toBeInstanceOf(DecisionConfigError);
                expect((err as DecisionConfigError).variable).toBe('PLATFORM');
                expect((err as DecisionConfigError).message).toContain('darwin arm64');
            }
        });

        it('LayaWorkerClient constructor refuses unsupported platform immediately', () => {
            expect(() => new LayaWorkerClient({ platform: 'linux', arch: 'arm64' })).toThrow(DecisionConfigError);
            expect(() => new LayaWorkerClient({ platform: 'darwin', arch: 'x64' })).toThrow(DecisionConfigError);
        });

        it('accepts darwin arm64 without error', () => {
            expect(() => validateHostPrerequisites('darwin', 'arm64')).not.toThrow();
        });
    });

    describe('R2, R3, AC2 — missing interpreter and runtime reported as config errors', () => {
        it('reports a missing interpreter as DecisionConfigError with install guidance', async () => {
            const client = new LayaWorkerClient({
                pythonPath: 'nonexistent-python-interpreter-xyz',
                platform: 'darwin',
                arch: 'arm64',
            });
            const err = await client.ask('s', { q1: q('fine') }).catch((caught) => caught);
            expect(err).toBeInstanceOf(DecisionConfigError);
            expect((err as DecisionConfigError).variable).toBe('LAYA_PYTHON');
            expect((err as DecisionConfigError).message).toContain('LAYA_PYTHON');
            expect((err as DecisionConfigError).message).toContain('brew install python');
            // Proves R3: raw process-spawn failure does not leak unwrapped
            expect(err).toBeInstanceOf(DecisionError);
            client.dispose();
        });

        it('resolves pythonPath from injected env.LAYA_PYTHON when pythonPath option is omitted', async () => {
            const client = new LayaWorkerClient({
                env: { LAYA_PYTHON: 'nonexistent-python-from-env' },
                platform: 'darwin',
                arch: 'arm64',
            });
            const err = await client.ask('s', { q1: q('fine') }).catch((caught) => caught);
            expect(err).toBeInstanceOf(DecisionConfigError);
            expect((err as DecisionConfigError).variable).toBe('LAYA_PYTHON');
            expect((err as DecisionConfigError).message).toContain('nonexistent-python-from-env');
            client.dispose();
        });

        it('reports missing laya-mlx runtime import as DecisionConfigError naming pip install laya-mlx', async () => {
            const client = new LayaWorkerClient({
                module: 'nonexistent_laya_runtime_module',
                platform: 'darwin',
                arch: 'arm64',
            });
            const err = await client.ask('s', { q1: q('fine') }).catch((caught) => caught);
            expect(err).toBeInstanceOf(DecisionConfigError);
            expect((err as DecisionConfigError).variable).toBe('LAYA_PYTHON');
            expect((err as DecisionConfigError).message).toContain('pip install laya-mlx');
            client.dispose();
        });
    });

    describe('R4, AC1 — worker error kind translation', () => {
        it('maps config error kind to DecisionConfigError', () => {
            const err = translateWorkerError('config', 'unsupported batch_size 0');
            expect(err).toBeInstanceOf(DecisionConfigError);
            expect(err.message).toContain('unsupported batch_size 0');
        });

        it('maps request error kind to DecisionRequestError', () => {
            const err = translateWorkerError('request', 'question missing instructions');
            expect(err).toBeInstanceOf(DecisionRequestError);
            expect((err as DecisionRequestError).bodySummary).toBe('question missing instructions');
        });

        it('maps backend error kind to DecisionBackendError', () => {
            const err = translateWorkerError('backend', 'internal calculation error');
            expect(err).toBeInstanceOf(DecisionBackendError);
            expect(err.message).toContain('internal calculation error');
        });
    });

    describe('R5, AC4 — non-finite model outputs', () => {
        it('reports non-finite FloatingPointError as DecisionBackendError naming the precision remedy', async () => {
            const client = new LayaWorkerClient({
                module: 'tests.fixtures.stub_laya',
                platform: 'darwin',
                arch: 'arm64',
            });
            const err = await client.ask('s', { boom: q('boom') }).catch((caught) => caught);
            expect(err).toBeInstanceOf(DecisionBackendError);
            expect((err as DecisionBackendError).message).toContain('Non-finite model outputs');
            expect((err as DecisionBackendError).message).toContain("dtype='float32'");
            client.dispose();
        });

        it('translateWorkerError detects non-finite messages and maps to DecisionBackendError', () => {
            const err = translateWorkerError('backend', 'Non-finite model outputs; retry with dtype=float32');
            expect(err).toBeInstanceOf(DecisionBackendError);
            expect(err.message).toContain('float32');
        });
    });

    describe('R6, AC1 — credential and transport resolution failures', () => {
        it('maps 401 / Unauthorized / HF_TOKEN resolution failures to DecisionAuthError', () => {
            const err401 = translateWorkerError('backend', '401 Unauthorized: Invalid HF_TOKEN');
            expect(err401).toBeInstanceOf(DecisionAuthError);
            expect((err401 as DecisionAuthError).status).toBe(401);

            const errGated = translateWorkerError('config', '403 Forbidden: GatedRepo access denied');
            expect(errGated).toBeInstanceOf(DecisionAuthError);
            expect((errGated as DecisionAuthError).status).toBe(403);
        });

        it('maps transport failures to DecisionConnectionError', () => {
            const errConn = translateWorkerError(
                'backend',
                'ConnectionError: Failed to establish a new connection to huggingface.co',
            );
            expect(errConn).toBeInstanceOf(DecisionConnectionError);

            const errUnreach = translateWorkerError('config', 'Network is unreachable');
            expect(errUnreach).toBeInstanceOf(DecisionConnectionError);
        });
    });

    describe('R7, AC1 — timeout paths surface as DecisionTimeoutError', () => {
        it('surfaces startup timeout as DecisionTimeoutError', async () => {
            const client = new LayaWorkerClient({
                modelId: 'stub/slow-start',
                module: 'tests.fixtures.stub_laya',
                startupTimeoutMs: 150,
                platform: 'darwin',
                arch: 'arm64',
            });
            const err = await client.ask('s', { q1: q('fine') }).catch((caught) => caught);
            expect(err).toBeInstanceOf(DecisionTimeoutError);
            expect((err as DecisionTimeoutError).timeoutMs).toBe(150);
            client.dispose();
        });

        it('surfaces request timeout as DecisionTimeoutError', async () => {
            const client = new LayaWorkerClient({
                module: 'tests.fixtures.stub_laya',
                requestTimeoutMs: 150,
                platform: 'darwin',
                arch: 'arm64',
            });
            const err = await client.ask('s', { q1: q('slow') }).catch((caught) => caught);
            expect(err).toBeInstanceOf(DecisionTimeoutError);
            expect((err as DecisionTimeoutError).timeoutMs).toBe(150);
            client.dispose();
        });
    });
});
