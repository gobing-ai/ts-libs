import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _resetNodeFileSystem, nodeBunFactory } from '../src/runtime-node-bun';

const PROJECT_ROOT = nodeBunFactory.createFileSystem().getProjectRoot();
const CONFIG_DIR = join(PROJECT_ROOT, 'config');
const CONFIG_FILE = join(CONFIG_DIR, 'config.yaml');
const TEMP_CONFIG = join(PROJECT_ROOT, 'temp-test-config.yaml');

_resetNodeFileSystem(); // start clean

// ── Test helpers ──────────────────────────────────────────────────────────

function cleanupConfig(): void {
    try {
        rmSync(CONFIG_FILE, { force: true });
    } catch {
        /* ok */
    }
    try {
        rmSync(TEMP_CONFIG, { force: true });
    } catch {
        /* ok */
    }
    try {
        rmSync(CONFIG_DIR, { force: true, recursive: true });
    } catch {
        /* ok */
    }
    delete process.env.CONFIG_PATH;
    _resetNodeFileSystem();
}

function writeConfig(content: string, path = CONFIG_FILE): void {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf-8');
}

// ── nodeBunFactory ────────────────────────────────────────────────────────

describe('nodeBunFactory', () => {
    describe('static properties', () => {
        test('runtimeName', () => {
            expect(nodeBunFactory.runtimeName).toBe('node-bun');
        });

        test('capabilities', () => {
            expect(nodeBunFactory.capabilities).toEqual({
                hasFilesystem: true,
                hasProcessExecution: true,
                hasPersistentStorage: true,
            });
        });
    });

    describe('createFileSystem', () => {
        test('returns a filesystem with a project root', () => {
            const fs = nodeBunFactory.createFileSystem();
            expect(fs.getProjectRoot()).toBeString();
        });
    });

    describe('createProcessExecutor', () => {
        test('returns an executor', () => {
            const exec = nodeBunFactory.createProcessExecutor();
            expect(typeof exec.run).toBe('function');
            expect(typeof exec.runStreaming).toBe('function');
        });

        test('can run a simple command and capture output', async () => {
            const exec = nodeBunFactory.createProcessExecutor();
            const result = await exec.run({ command: 'echo', args: ['hello-test'] });
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain('hello-test');
        });

        test('can run a command that fails (rejectOnError)', async () => {
            const exec = nodeBunFactory.createProcessExecutor();
            try {
                await exec.run({ command: 'sh', args: ['-c', 'exit 42'], rejectOnError: true });
                expect.unreachable('should have thrown');
            } catch (err: unknown) {
                const e = err as { exitCode?: number };
                expect(e.exitCode).toBe(42);
            }
        });

        test('can run a command with cwd', async () => {
            const exec = nodeBunFactory.createProcessExecutor();
            const result = await exec.run({ command: 'pwd', args: [], cwd: '/tmp' });
            expect(result.stdout).toContain('/tmp');
        });

        test('can run a command with timeout', async () => {
            const exec = nodeBunFactory.createProcessExecutor();
            const result = await exec.run({ command: 'sleep', args: ['0.1'], timeout: 5000 });
            expect(result.exitCode).toBe(0);
        });
    });

    describe('loadConfig', () => {
        beforeAll(cleanupConfig);
        afterAll(cleanupConfig);

        beforeEach(() => {
            delete process.env.CONFIG_PATH;
            _resetNodeFileSystem();
        });

        test('returns defaults when no config file exists', async () => {
            // Ensure no config file is present and CONFIG_PATH is unset
            cleanupConfig();
            const config = await nodeBunFactory.loadConfig();
            expect(config.app.name).toBe('app');
            expect(config.app.env).toBe('development');
            expect(config.app.port).toBe(3000);
            expect(config.database.url).toBe(':memory:');
            expect(config.logging.level).toBe('info');
        });

        test('reads YAML from config/config.yaml', async () => {
            cleanupConfig();
            writeConfig(`
app:
  name: my-app
  port: 8080
database:
  url: postgres://localhost/test
logging:
  level: debug
`);
            const config = await nodeBunFactory.loadConfig();
            expect(config.app.name).toBe('my-app');
            expect(config.app.port).toBe(8080);
            expect(config.app.env).toBe('development'); // default preserved
            expect(config.database.url).toBe('postgres://localhost/test');
            expect(config.logging.level).toBe('debug');
        });

        test('reads YAML from CONFIG_PATH env var', async () => {
            cleanupConfig();
            writeConfig(
                `
app:
  name: env-path-app
  port: 9090
`,
                TEMP_CONFIG,
            );
            process.env.CONFIG_PATH = TEMP_CONFIG;
            _resetNodeFileSystem();

            const config = await nodeBunFactory.loadConfig();
            expect(config.app.name).toBe('env-path-app');
            expect(config.app.port).toBe(9090);
        });

        test('CONFIG_PATH takes precedence over config/config.yaml', async () => {
            cleanupConfig();
            writeConfig(
                `
app:
  name: fallback-app
`,
                CONFIG_FILE,
            );
            writeConfig(
                `
app:
  name: primary-app
`,
                TEMP_CONFIG,
            );
            process.env.CONFIG_PATH = TEMP_CONFIG;
            _resetNodeFileSystem();

            const config = await nodeBunFactory.loadConfig();
            expect(config.app.name).toBe('primary-app');
        });

        test('merges overrides on top of file config', async () => {
            cleanupConfig();
            writeConfig(`
app:
  name: base-app
  port: 3000
`);
            const config = await nodeBunFactory.loadConfig({
                overrides: { app: { name: 'overridden-app', env: 'development' as const, port: 3000 } },
            });
            expect(config.app.name).toBe('overridden-app');
            expect(config.app.port).toBe(3000); // from file, not overridden
        });

        test('overrides work even with defaults (no file)', async () => {
            cleanupConfig();
            const config = await nodeBunFactory.loadConfig({
                overrides: { app: { name: 'cli-app', env: 'development' as const, port: 5555 } },
            });
            expect(config.app.name).toBe('cli-app');
            expect(config.app.port).toBe(5555);
            expect(config.app.env).toBe('development'); // default preserved
        });

        test('handles empty YAML file gracefully', async () => {
            cleanupConfig();
            writeConfig('');
            const config = await nodeBunFactory.loadConfig();
            expect(config.app.name).toBe('app'); // all defaults
        });

        test('ignores broken YAML file', async () => {
            cleanupConfig();
            writeConfig('{ broken: [');
            // Should fall through to defaults (readYamlConfig catches parse errors)
            const config = await nodeBunFactory.loadConfig();
            expect(config.app.name).toBe('app');
        });
    });
});

// ── _resetNodeFileSystem ──────────────────────────────────────────────────

describe('_resetNodeFileSystem', () => {
    test('clears cached filesystem so next call creates a fresh one', () => {
        _resetNodeFileSystem();
        const fs = nodeBunFactory.createFileSystem();
        expect(fs.getProjectRoot()).toBeString();
    });
});
