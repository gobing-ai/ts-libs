import { describe, expect, test } from 'bun:test';
import type { FileSystem, ProcessExecutor, ProcessOptions, ProcessResult } from '@gobing-ai/ts-runtime';
import { type AuthState, isAuthenticated } from '../../src/agents/auth-shims';
import { AiRunner } from '../../src/ai-runner';

/** Fake executor — returns a configured response per invocation. */
class FakeExecutor implements ProcessExecutor {
    constructor(private readonly responder: (options: ProcessOptions) => Partial<ProcessResult> = () => ({})) {}

    async run(options: ProcessOptions): Promise<ProcessResult> {
        return {
            command: options.command,
            args: options.args ?? [],
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 1,
            ...this.responder(options),
        };
    }

    runStreaming(): never {
        throw new Error('FakeExecutor.runStreaming not implemented');
    }
}

function makeRunner(responder: (options: ProcessOptions) => Partial<ProcessResult>): AiRunner {
    return new AiRunner({ processExecutor: new FakeExecutor(responder) });
}

/**
 * In-memory filesystem scoped to the credential paths the auth shim reads.
 * Only `readFile`/`stat` are exercised by `isAuthenticated`; the remaining
 * `FileSystem` members throw to surface accidental misuse in tests.
 */
class FakeFileSystem implements FileSystem {
    private readonly files = new Map<string, string>();

    set(path: string, content: string): this {
        this.files.set(path, content);
        return this;
    }

    async readFile(path: string): Promise<string> {
        const content = this.files.get(path);
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
    }

    async stat(path: string) {
        const content = this.files.get(path);
        if (content === undefined) return null;
        return { isFile: () => true, isDirectory: () => false, size: content.length, mtimeMs: 0 };
    }

    exists = async (p: string) => this.files.has(p);
    writeFile = async () => undefined;
    appendFile = async () => undefined;
    ensureDir = async () => undefined;
    readDir = async () => [];
    deleteFile = async () => undefined;
    rename = async () => undefined;
    copy = async () => undefined;
    createWriteStream(): { write(): void; end(): void } {
        throw new Error('FakeFileSystem.createWriteStream not implemented');
    }
    resolve = (...parts: string[]) => parts.join('/');
    getProjectRoot(): string {
        throw new Error('FakeFileSystem.getProjectRoot not implemented');
    }
}

function ctx(runner: AiRunner, opts: { fs?: FileSystem; env?: Record<string, string | undefined> } = {}) {
    return {
        runner,
        env: opts.env ?? {},
        fileSystem: opts.fs ?? new FakeFileSystem(),
        timeout: 1000,
    };
}

describe('isAuthenticated (tri-state)', () => {
    test('positive auth signal resolves to authenticated', async () => {
        const runner = makeRunner((options) =>
            options.args?.includes('--version') === true
                ? { stdout: 'claude 1.0.0' }
                : { stdout: '{"loggedIn": true}' },
        );
        const state = await isAuthenticated('claude', ctx(runner));
        expect(state).toBe<AuthState>('authenticated');
    });

    test('explicit logged-out signal resolves to unauthenticated', async () => {
        const runner = makeRunner((options) =>
            options.args?.includes('--version') === true ? { stdout: 'claude 1.0.0' } : { stdout: 'logged out' },
        );
        const state = await isAuthenticated('claude', ctx(runner));
        expect(state).toBe<AuthState>('unauthenticated');
    });

    test('non-zero exit code resolves to unauthenticated', async () => {
        const runner = makeRunner((options) =>
            options.args?.includes('--version') === true ? { stdout: 'claude 1.0.0' } : { exitCode: 2, stdout: '' },
        );
        const state = await isAuthenticated('claude', ctx(runner));
        expect(state).toBe<AuthState>('unauthenticated');
    });

    test('inconclusive exit-0 output resolves to unknown (not unauthenticated)', async () => {
        const runner = makeRunner((options) =>
            options.args?.includes('--version') === true
                ? { stdout: 'claude 1.0.0' }
                : { stdout: 'usage: claude auth' },
        );
        const state = await isAuthenticated('claude', ctx(runner));
        expect(state).toBe<AuthState>('unknown');
    });

    test('agent with no auth verb resolves to unknown', async () => {
        // antigravity-cli shim: getAuthCommand() => null — no probe exists.
        const runner = makeRunner(() => ({ stdout: 'unused' }));
        const state = await isAuthenticated('antigravity-cli', ctx(runner));
        expect(state).toBe<AuthState>('unknown');
    });

    test('pi/omp with a non-empty provider key resolve to authenticated', async () => {
        const runner = makeRunner((options) =>
            options.args?.includes('--version') === true ? { stdout: 'omp 1.0.0' } : { stdout: '' },
        );
        const state = await isAuthenticated('omp', ctx(runner, { env: { GOOGLE_API_KEY: 'real-key' } }));
        expect(state).toBe<AuthState>('authenticated');
    });

    test('pi/omp with a blank provider key fall through to the CLI probe', async () => {
        const runner = makeRunner((options) =>
            options.args?.includes('--version') === true ? { stdout: 'omp 1.0.0' } : { stdout: 'not authenticated' },
        );
        const state = await isAuthenticated('omp', ctx(runner, { env: { GOOGLE_API_KEY: '   ' } }));
        expect(state).toBe<AuthState>('unauthenticated');
    });

    test('gemini with a credential-bearing settings.json is authenticated', async () => {
        const runner = makeRunner(() => ({ stdout: 'gemini 1.0.0' }));
        const fs = new FakeFileSystem().set('/home/.gemini/settings.json', '{"token":"live"}');
        const state = await isAuthenticated('gemini', ctx(runner, { fs, env: { HOME: '/home' } }));
        expect(state).toBe<AuthState>('authenticated');
    });

    test('gemini with prefs-only settings.json is unauthenticated', async () => {
        const runner = makeRunner(() => ({ stdout: 'gemini 1.0.0' }));
        const fs = new FakeFileSystem().set('/home/.gemini/settings.json', '{"theme":"dark"}');
        const state = await isAuthenticated('gemini', ctx(runner, { fs, env: { HOME: '/home' } }));
        expect(state).toBe<AuthState>('unauthenticated');
    });

    test('gemini with no settings.json is unknown', async () => {
        const runner = makeRunner(() => ({ stdout: 'gemini 1.0.0' }));
        const state = await isAuthenticated('gemini', ctx(runner, { env: { HOME: '/home' } }));
        expect(state).toBe<AuthState>('unknown');
    });

    test('never throws — a rejecting probe resolves to unknown', async () => {
        // A runner whose auth command rejects (e.g. spawn ENOENT) must not throw.
        const runner = { runAuthCommand: () => Promise.reject(new Error('spawn ENOENT')) } as unknown as AiRunner;
        const state = await isAuthenticated('claude', ctx(runner));
        expect(state).toBe<AuthState>('unknown');
    });

    test('grok with non-empty XAI_API_KEY is authenticated', async () => {
        const runner = makeRunner(() => ({ stdout: 'unused' }));
        const state = await isAuthenticated(
            'grok',
            ctx(runner, { env: { XAI_API_KEY: 'xai-test-key', HOME: '/home' } }),
        );
        expect(state).toBe<AuthState>('authenticated');
    });

    test('grok with blank XAI_API_KEY does not count as authenticated', async () => {
        const runner = makeRunner(() => ({ stdout: 'unused' }));
        const state = await isAuthenticated('grok', ctx(runner, { env: { XAI_API_KEY: '   ', HOME: '/home' } }));
        expect(state).toBe<AuthState>('unknown');
    });

    test('grok with non-empty ~/.grok/auth.json is authenticated', async () => {
        const runner = makeRunner(() => ({ stdout: 'unused' }));
        const fs = new FakeFileSystem().set('/home/.grok/auth.json', '{"access_token":"live"}');
        const state = await isAuthenticated('grok', ctx(runner, { fs, env: { HOME: '/home' } }));
        expect(state).toBe<AuthState>('authenticated');
    });

    test('grok with neither env key nor auth file is unknown (not unauthenticated)', async () => {
        const runner = makeRunner(() => ({ stdout: 'unused' }));
        const state = await isAuthenticated('grok', ctx(runner, { env: { HOME: '/home' } }));
        expect(state).toBe<AuthState>('unknown');
    });
});
