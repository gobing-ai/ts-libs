import { describe, expect, test } from 'bun:test';
import {
    AGENT_SHIMS,
    type AgentName,
    DISPLAY_ORDER,
    getAgentShim,
    isAgentName,
    resolveAgentName,
    TIER1_PRIORITY,
    TIER2_AGENTS,
} from '../../src/agents/shims';

describe('Agent shims', () => {
    test('isAgentName returns true for canonical ids, aliases, and false for unknown', () => {
        // Canonical ids
        expect(isAgentName('claude')).toBe(true);
        expect(isAgentName('codex')).toBe(true);
        expect(isAgentName('gemini')).toBe(true);
        expect(isAgentName('pi')).toBe(true);
        expect(isAgentName('opencode')).toBe(true);
        expect(isAgentName('antigravity-cli')).toBe(true);
        expect(isAgentName('openclaw')).toBe(true);
        expect(isAgentName('hermes')).toBe(true);
        expect(isAgentName('omp')).toBe(true);
        expect(isAgentName('grok')).toBe(true);
        // Alias
        expect(isAgentName('antigravity')).toBe(true);

        expect(isAgentName('')).toBe(false);
        expect(isAgentName('cursor')).toBe(false);
        expect(isAgentName('copilot')).toBe(false);
    });

    test('isAgentName no longer narrows; resolveAgentName yields the canonical', () => {
        const candidate = 'antigravity';
        // isAgentName is alias-aware membership only (no narrowing); resolve to get canonical.
        if (isAgentName(candidate)) {
            const canonical = resolveAgentName(candidate);
            if (canonical === undefined) expect.unreachable('antigravity should resolve');
            else {
                const shim = getAgentShim(canonical);
                expect(shim.name).toBe('antigravity-cli');
            }
        }
    });

    test('getAgentShim returns correct shim for every canonical agent', () => {
        const names = Object.keys(AGENT_SHIMS) as AgentName[];
        for (const name of names) {
            const shim = getAgentShim(name);
            expect(shim.name).toBe(name);
            expect(shim.command).toBeString();
            expect([1, 2]).toContain(shim.tier);
            expect(shim.getHelpCommand().command).toBe(shim.command);
            expect(shim.getVersionCommand().command).toBe(shim.command);
            expect(shim.getPromptCommand({ input: 'test' }).args).toBeArray();
        }
    });

    test('TIER2_AGENTS contains openclaw only (antigravity promoted to tier-1 antigravity-cli)', () => {
        expect(TIER2_AGENTS.has('openclaw')).toBe(true);
        expect(TIER2_AGENTS.has('antigravity-cli')).toBe(false);
        expect(TIER2_AGENTS.has('claude')).toBe(false);
        expect(TIER2_AGENTS.has('pi')).toBe(false);
    });

    test('DISPLAY_ORDER includes all bundled canonical agents with no duplicates', () => {
        expect(DISPLAY_ORDER.length).toBeGreaterThanOrEqual(10);
        expect(new Set(DISPLAY_ORDER).size).toBe(DISPLAY_ORDER.length);
        expect(DISPLAY_ORDER).toContain('grok');
        for (const name of DISPLAY_ORDER) {
            expect(isAgentName(name)).toBe(true);
        }
        // Every canonical id appears in DISPLAY_ORDER exactly once.
        expect(new Set(DISPLAY_ORDER).size).toBe(Object.keys(AGENT_SHIMS).length);
    });

    test('TIER1_PRIORITY contains only tier-1 agents in priority order', () => {
        for (const name of TIER1_PRIORITY) {
            expect(getAgentShim(name).tier).toBe(1);
        }
    });
});

describe('resolveAgentName', () => {
    test('canonical ids resolve to themselves', () => {
        expect(resolveAgentName('claude')).toBe('claude');
        expect(resolveAgentName('pi')).toBe('pi');
        expect(resolveAgentName('omp')).toBe('omp');
        expect(resolveAgentName('hermes')).toBe('hermes');
        expect(resolveAgentName('antigravity-cli')).toBe('antigravity-cli');
        expect(resolveAgentName('openclaw')).toBe('openclaw');
        expect(resolveAgentName('grok')).toBe('grok');
    });

    test('alias resolves to canonical', () => {
        expect(resolveAgentName('antigravity')).toBe('antigravity-cli');
    });

    test('deprecated-but-not-aliased id resolves to itself', () => {
        // gemini is deprecated (replacedBy antigravity-cli) but NOT aliased — it stays canonical.
        expect(resolveAgentName('gemini')).toBe('gemini');
    });

    test('unknown id resolves to undefined', () => {
        expect(resolveAgentName('cursor')).toBeUndefined();
        expect(resolveAgentName('')).toBeUndefined();
        expect(resolveAgentName('antigravity-ide')).toBeUndefined();
    });

    test('getAgentShim resolves alias to the canonical shim binary', () => {
        // 'antigravity' alias → antigravity-cli shim → binary 'agy'
        const canonical = resolveAgentName('antigravity');
        expect(canonical).toBe('antigravity-cli');
        expect(getAgentShim(canonical ?? 'antigravity-cli').command).toBe('agy');
    });
});

describe('new agent shims', () => {
    test('omp shim builds Pi-compatible argv', () => {
        const shim = getAgentShim('omp');
        expect(shim.command).toBe('omp');
        expect(shim.tier).toBe(1);
        // one-shot
        expect(shim.getPromptCommand({ input: 'ship it', mode: 'json' })).toEqual({
            command: 'omp',
            args: ['--no-session', '-p', 'ship it', '--mode', 'json'],
        });
        // resume
        expect(shim.getPromptCommand({ input: '', continue: true })).toEqual({
            command: 'omp',
            args: ['-p', '', '-c', '--mode', 'text'],
        });
        // model override
        expect(shim.getPromptCommand({ input: 'x', model: 'gpt-5' })).toEqual({
            command: 'omp',
            args: ['--no-session', '-p', 'x', '--model', 'gpt-5', '--mode', 'text'],
        });
        // auth + help + version
        expect(shim.getAuthCommand()).toEqual({ command: 'omp', args: ['--list-models'] });
        expect(shim.getHelpCommand()).toEqual({ command: 'omp', args: ['--help'] });
        expect(shim.getVersionCommand()).toEqual({ command: 'omp', args: ['--version'] });
    });

    test('hermes shim builds chat -q argv', () => {
        const shim = getAgentShim('hermes');
        expect(shim.command).toBe('hermes');
        expect(shim.tier).toBe(1);
        expect(shim.getPromptCommand({ input: 'review the repo' })).toEqual({
            command: 'hermes',
            args: ['chat', '-q', 'review the repo'],
        });
        expect(shim.getPromptCommand({ input: 'x', continue: true, model: 'claude-sonnet-4' })).toEqual({
            command: 'hermes',
            args: ['chat', '-q', 'x', '--continue', '-m', 'claude-sonnet-4'],
        });
        expect(shim.getAuthCommand()).toEqual({ command: 'hermes', args: ['doctor'] });
        expect(shim.getHelpCommand()).toEqual({ command: 'hermes', args: ['chat', '--help'] });
        expect(shim.getVersionCommand()).toEqual({ command: 'hermes', args: ['--version'] });
    });

    test('antigravity-cli shim builds agy -p argv (tier 1)', () => {
        const shim = getAgentShim('antigravity-cli');
        expect(shim.command).toBe('agy');
        expect(shim.tier).toBe(1);
        expect(shim.getPromptCommand({ input: 'ship it' })).toEqual({ command: 'agy', args: ['-p', 'ship it'] });
        expect(shim.getPromptCommand({ input: 'x', continue: true, model: 'claude-opus-4' })).toEqual({
            command: 'agy',
            args: ['-p', 'x', '--continue', '--model', 'claude-opus-4'],
        });
        expect(shim.getAuthCommand()).toBeNull();
        expect(shim.getHelpCommand()).toEqual({ command: 'agy', args: ['--help'] });
        expect(shim.getVersionCommand()).toEqual({ command: 'agy', args: ['--version'] });
    });

    test('grok shim builds -p/-c/-m/--output-format argv (tier 1)', () => {
        const shim = getAgentShim('grok');
        expect(shim.command).toBe('grok');
        expect(shim.tier).toBe(1);
        // one-shot defaults mode text → --output-format plain
        expect(shim.getPromptCommand({ input: 'ship it' })).toEqual({
            command: 'grok',
            args: ['-p', 'ship it', '--output-format', 'plain'],
        });
        // continue + model + json
        expect(shim.getPromptCommand({ input: 'x', continue: true, model: 'grok-build', mode: 'json' })).toEqual({
            command: 'grok',
            args: ['-p', 'x', '-c', '-m', 'grok-build', '--output-format', 'json'],
        });
        // R8: mode text must never emit the bare format value "text"
        const textMode = shim.getPromptCommand({ input: 'y', mode: 'text' });
        expect(textMode.args).toContain('--output-format');
        expect(textMode.args).toContain('plain');
        expect(textMode.args).not.toContain('text');
        // R9: no auth-status CLI verb
        expect(shim.getAuthCommand()).toBeNull();
        expect(shim.getHelpCommand()).toEqual({ command: 'grok', args: ['--help'] });
        expect(shim.getVersionCommand()).toEqual({ command: 'grok', args: ['--version'] });
    });
});

describe('deprecation metadata', () => {
    test('gemini is deprecated with replacedBy antigravity-cli', () => {
        const shim = getAgentShim('gemini');
        expect(shim.deprecated).toEqual({ since: '2026-06-20', replacedBy: 'antigravity-cli' });
    });

    test('antigravity-cli carries the antigravity alias and is not itself deprecated', () => {
        const shim = getAgentShim('antigravity-cli');
        expect(shim.aliases).toContain('antigravity');
        // The canonical antigravity-cli is the active successor — not deprecated.
        expect(shim.deprecated).toBeUndefined();
    });

    test('non-deprecated agents have no deprecation metadata', () => {
        for (const name of ['claude', 'codex', 'pi', 'omp', 'hermes', 'opencode', 'openclaw', 'grok'] as AgentName[]) {
            expect(getAgentShim(name).deprecated).toBeUndefined();
        }
    });
});
