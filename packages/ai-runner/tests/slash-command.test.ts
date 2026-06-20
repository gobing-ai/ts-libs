import { describe, expect, test } from 'bun:test';
import { isClaudeStyleSlashCommand, translateSlashCommand } from '../src/slash-command';

describe('isClaudeStyleSlashCommand', () => {
    test('recognizes a bare /plugin:command', () => {
        expect(isClaudeStyleSlashCommand('/rd3:dev-run')).toBe(true);
    });

    test('recognizes /plugin:command with trailing args', () => {
        expect(isClaudeStyleSlashCommand('/rd3:dev-run 0004 --fix all')).toBe(true);
    });

    test('accepts dots, underscores, and dashes in plugin and command', () => {
        expect(isClaudeStyleSlashCommand('/my.plugin_x:do-it_now')).toBe(true);
    });

    test('rejects input without the plugin:command colon form', () => {
        expect(isClaudeStyleSlashCommand('/dev-run')).toBe(false);
        expect(isClaudeStyleSlashCommand('Fix the login bug')).toBe(false);
        expect(isClaudeStyleSlashCommand('')).toBe(false);
    });

    test('rejects a slash command missing the leading slash', () => {
        expect(isClaudeStyleSlashCommand('rd3:dev-run')).toBe(false);
    });
});

describe('translateSlashCommand', () => {
    test('claude is a pass-through', () => {
        expect(translateSlashCommand('claude', '/rd3:dev-run')).toBe('/rd3:dev-run');
        expect(translateSlashCommand('claude', '/rd3:dev-run 0004')).toBe('/rd3:dev-run 0004');
    });

    test('codex uses the $plugin-command form', () => {
        expect(translateSlashCommand('codex', '/rd3:dev-run')).toBe('$rd3-dev-run');
        expect(translateSlashCommand('codex', '/rd3:dev-run 0004')).toBe('$rd3-dev-run 0004');
    });

    test('pi and omp use the /skill:plugin-command form', () => {
        expect(translateSlashCommand('pi', '/rd3:dev-run')).toBe('/skill:rd3-dev-run');
        expect(translateSlashCommand('pi', '/rd3:dev-run 0004')).toBe('/skill:rd3-dev-run 0004');
        expect(translateSlashCommand('omp', '/rd3:dev-run')).toBe('/skill:rd3-dev-run');
        expect(translateSlashCommand('omp', '/rd3:dev-fixall x')).toBe('/skill:rd3-dev-fixall x');
    });

    test('other agents collapse the namespace to /plugin-command', () => {
        expect(translateSlashCommand('gemini', '/rd3:dev-run')).toBe('/rd3-dev-run');
        expect(translateSlashCommand('opencode', '/rd3:dev-run 0004')).toBe('/rd3-dev-run 0004');
        expect(translateSlashCommand('antigravity-cli', '/rd3:dev-run')).toBe('/rd3-dev-run');
        expect(translateSlashCommand('openclaw', '/rd3:dev-run')).toBe('/rd3-dev-run');
        expect(translateSlashCommand('hermes', '/rd3:dev-run')).toBe('/rd3-dev-run');
    });

    test('non-slash-command input is returned unchanged for every agent', () => {
        const plain = 'Fix the login bug';
        expect(translateSlashCommand('claude', plain)).toBe(plain);
        expect(translateSlashCommand('codex', plain)).toBe(plain);
        expect(translateSlashCommand('pi', plain)).toBe(plain);
        expect(translateSlashCommand('gemini', plain)).toBe(plain);
    });

    test('collapses extra leading whitespace between command and args', () => {
        expect(translateSlashCommand('codex', '/rd3:dev-run    0004')).toBe('$rd3-dev-run 0004');
    });
});
