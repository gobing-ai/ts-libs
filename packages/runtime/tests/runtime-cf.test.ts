import { describe, expect, test } from 'bun:test';
import { cloudflareWorkersFactory } from '../src/runtime-cf';

describe('cloudflareWorkersFactory', () => {
    // ── identity ────────────────────────────────────────────────────────

    test('runtimeName is cloudflare-workers', () => {
        expect(cloudflareWorkersFactory.runtimeName).toBe('cloudflare-workers');
    });

    test('capabilities indicate no filesystem or process', () => {
        expect(cloudflareWorkersFactory.capabilities.hasFilesystem).toBe(false);
        expect(cloudflareWorkersFactory.capabilities.hasProcessExecution).toBe(false);
    });

    // ── createFileSystem ────────────────────────────────────────────────

    test('createFileSystem returns cf stub', () => {
        const fs = cloudflareWorkersFactory.createFileSystem();
        expect(fs.getProjectRoot()).toBe('/bundle');
    });

    // ── createProcessExecutor ───────────────────────────────────────────

    test('createProcessExecutor throws with full message', () => {
        expect(() => cloudflareWorkersFactory.createProcessExecutor()).toThrow(
            'ProcessExecutor is not available on Cloudflare Workers.',
        );
    });

    test('createProcessExecutor throws even when config is passed', () => {
        expect(() => cloudflareWorkersFactory.createProcessExecutor({})).toThrow(
            'ProcessExecutor is not available on Cloudflare Workers.',
        );
    });

    // ── loadConfig ──────────────────────────────────────────────────────

    test('loadConfig returns defaults when called with no options', async () => {
        const cfg = await cloudflareWorkersFactory.loadConfig();
        expect(cfg.app).toEqual({ name: 'app', env: 'development', port: 3000 });
        expect(cfg.database).toEqual({ url: ':memory:' });
        expect(cfg.logging).toMatchObject({ level: 'info', console: true });
    });

    test('loadConfig returns defaults when called with empty options', async () => {
        const cfg = await cloudflareWorkersFactory.loadConfig({});
        expect(cfg.app).toEqual({ name: 'app', env: 'development', port: 3000 });
        expect(cfg.database).toEqual({ url: ':memory:' });
    });

    test('loadConfig returns defaults when envBindings has no CONFIG_YAML key', async () => {
        const cfg = await cloudflareWorkersFactory.loadConfig({
            envBindings: { OTHER_VAR: 'hello' },
        });
        expect(cfg.app).toEqual({ name: 'app', env: 'development', port: 3000 });
        expect(cfg.database).toEqual({ url: ':memory:' });
    });

    test('loadConfig parses valid CONFIG_YAML binding', async () => {
        const yaml = `
app:
  name: cf-test-app
  port: 8080
logging:
  level: debug
`.trim();

        const cfg = await cloudflareWorkersFactory.loadConfig({
            envBindings: { CONFIG_YAML: yaml },
        });

        expect(cfg.app.name).toBe('cf-test-app');
        expect(cfg.app.port).toBe(8080);
        expect(cfg.app.env).toBe('development'); // default
        expect(cfg.database.url).toBe(':memory:'); // default
        expect(cfg.logging.level).toBe('debug');
    });

    test('loadConfig returns defaults when CONFIG_YAML is invalid', async () => {
        const cfg = await cloudflareWorkersFactory.loadConfig({
            envBindings: { CONFIG_YAML: '}[{ garbage: yeah' },
        });

        expect(cfg.app).toEqual({ name: 'app', env: 'development', port: 3000 });
        expect(cfg.database).toEqual({ url: ':memory:' });
        expect(cfg.logging.level).toBe('info');
    });

    test('loadConfig returns defaults when CONFIG_YAML is an empty string', async () => {
        const cfg = await cloudflareWorkersFactory.loadConfig({
            envBindings: { CONFIG_YAML: '' },
        });

        expect(cfg.app).toEqual({ name: 'app', env: 'development', port: 3000 });
    });

    test('loadConfig applies overrides on top of parsed CONFIG_YAML', async () => {
        const yaml = `
app:
  name: yaml-app
  port: 7000
`.trim();
        const cfg = await cloudflareWorkersFactory.loadConfig({
            envBindings: { CONFIG_YAML: yaml },
            overrides: { app: { name: 'override-app', env: 'development' as const, port: 3000 } },
        });

        expect(cfg.app.name).toBe('override-app');
        expect(cfg.app.port).toBe(3000); // from overrides, overrides YAML's 7000
        expect(cfg.app.env).toBe('development'); // default
    });

    test('loadConfig applies overrides when there is no CONFIG_YAML', async () => {
        const cfg = await cloudflareWorkersFactory.loadConfig({
            overrides: { app: { name: 'override-only', env: 'development' as const, port: 9000 } },
        });

        expect(cfg.app.name).toBe('override-only');
        expect(cfg.app.port).toBe(9000);
        expect(cfg.app.env).toBe('development'); // default
        expect(cfg.database.url).toBe(':memory:'); // default
    });

    test('loadConfig returns frozen config', async () => {
        const cfg = await cloudflareWorkersFactory.loadConfig();
        expect(Object.isFrozen(cfg)).toBe(true);
        expect(Object.isFrozen(cfg.app)).toBe(true);
        expect(() => {
            (cfg as Record<string, unknown>).app = {};
        }).toThrow();
    });

    test('loadConfig parses nested YAML objects', async () => {
        const yaml = `
database:
  url: postgres://db.example.com:5432/mydb
logging:
  console: false
  file: true
  filePath: /var/log/app.log
`.trim();

        const cfg = await cloudflareWorkersFactory.loadConfig({
            envBindings: { CONFIG_YAML: yaml },
        });

        expect(cfg.database.url).toBe('postgres://db.example.com:5432/mydb');
        expect(cfg.logging.console).toBe(false);
        expect(cfg.logging.file).toBe(true);
        expect(cfg.logging.filePath).toBe('/var/log/app.log');
    });
});
