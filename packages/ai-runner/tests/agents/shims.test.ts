import { describe, expect, test } from 'bun:test';
import {
    AGENT_SHIMS,
    type AgentName,
    DISPLAY_ORDER,
    getAgentSessionCapability,
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
        expect(isAgentName('agy')).toBe(true);

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
        // The `agy` binary identity is also an alias (task 0038 R4).
        expect(resolveAgentName('agy')).toBe('antigravity-cli');
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
        expect(shim.getPromptCommand({ input: 'ship it' })).toEqual({
            command: 'agy',
            args: ['-p', 'ship it', '--mode', 'accept-edits'],
        });
        expect(shim.getPromptCommand({ input: 'x', continue: true, model: 'claude-opus-4' })).toEqual({
            command: 'agy',
            args: ['-p', 'x', '--mode', 'accept-edits', '--continue', '--model', 'claude-opus-4'],
        });
        // spur 0689: workspace threads to --add-dir so headless relative writes
        // land in the project tree instead of agy's scratch dir.
        expect(shim.getPromptCommand({ input: 'x', workspace: '/repo' }).args).toEqual([
            '-p',
            'x',
            '--mode',
            'accept-edits',
            '--add-dir',
            '/repo',
        ]);
        const timeoutArgs = shim.getPromptCommand({ input: 'x', timeoutMs: 1_800_000 }).args;
        expect(timeoutArgs).toContain('--print-timeout');
        expect(timeoutArgs).toContain('1800000ms');
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
            args: ['-p', 'ship it', '--allow', 'Write', '--allow', 'Edit', '--output-format', 'plain'],
        });
        // continue + model + json
        expect(shim.getPromptCommand({ input: 'x', continue: true, model: 'grok-build', mode: 'json' })).toEqual({
            command: 'grok',
            args: [
                '-p',
                'x',
                '--allow',
                'Write',
                '--allow',
                'Edit',
                '-c',
                '-m',
                'grok-build',
                '--output-format',
                'json',
            ],
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
        expect(shim.aliases).toContain('agy');
        // The canonical antigravity-cli is the active successor — not deprecated.
        expect(shim.deprecated).toBeUndefined();
    });

    test('non-deprecated agents have no deprecation metadata', () => {
        for (const name of ['claude', 'codex', 'pi', 'omp', 'hermes', 'opencode', 'openclaw', 'grok'] as AgentName[]) {
            expect(getAgentShim(name).deprecated).toBeUndefined();
        }
    });
});

// ── 0447 R2/R3/R5: session-affinity capability + argv matrix ──────────────

describe('getAgentSessionCapability (0447 R2)', () => {
    test('omp and pi fully support resume-by-id and session-dir', () => {
        expect(getAgentSessionCapability('omp')).toEqual({ supportsResumeById: true, supportsSessionDir: true });
        expect(getAgentSessionCapability('pi')).toEqual({ supportsResumeById: true, supportsSessionDir: true });
    });

    test('claude supports resume-by-id but no session-dir', () => {
        expect(getAgentSessionCapability('claude')).toEqual({ supportsResumeById: true, supportsSessionDir: false });
    });

    test('codex degrades (no resume-by-id, no session-dir)', () => {
        expect(getAgentSessionCapability('codex')).toEqual({ supportsResumeById: false, supportsSessionDir: false });
    });

    test('agy and grok support resume-by-id, no session-dir', () => {
        expect(getAgentSessionCapability('antigravity-cli')).toEqual({
            supportsResumeById: true,
            supportsSessionDir: false,
        });
        expect(getAgentSessionCapability('grok')).toEqual({ supportsResumeById: true, supportsSessionDir: false });
    });

    test('every bundled agent has a capability entry', () => {
        for (const name of Object.keys(AGENT_SHIMS) as AgentName[]) {
            expect(getAgentSessionCapability(name)).toBeDefined();
        }
    });
});

describe('session-affinity argv matrix (0447 R3/R5)', () => {
    // Per-agent argv locks for the four precedence states: fresh, sessionDir-only,
    // sessionId+sessionDir, continue-only (legacy). R5: session* set → pin/isolate
    // path that never emits unscoped global continue/last-session.
    const cases: Array<{
        agent: AgentName;
        name: string;
        fresh: string[];
        sessionDirOnly: string[];
        sessionIdAndDir: string[];
        continueOnly: string[];
    }> = [
        {
            agent: 'omp',
            name: 'omp',
            fresh: ['--no-session', '-p', '', '--mode', 'text'],
            sessionDirOnly: ['-p', '', '--session-dir', '/run/sess', '--mode', 'text'],
            sessionIdAndDir: ['-p', '', '--session-dir', '/run/sess', '-r', 'abc123', '--mode', 'text'],
            continueOnly: ['-p', '', '-c', '--mode', 'text'],
        },
        {
            agent: 'pi',
            name: 'pi',
            fresh: ['--no-session', '-p', '', '--mode', 'text'],
            sessionDirOnly: ['-p', '', '--session-dir', '/run/sess', '--mode', 'text'],
            sessionIdAndDir: ['-p', '', '--session-dir', '/run/sess', '-r', 'abc123', '--mode', 'text'],
            continueOnly: ['-p', '', '-c', '--mode', 'text'],
        },
        {
            agent: 'claude',
            name: 'claude',
            fresh: ['-p', '', '--permission-mode', 'acceptEdits', '--output-format', 'text'],
            // sessionDir unsupported → ignored; sessionId pins via --resume
            sessionDirOnly: ['-p', '', '--permission-mode', 'acceptEdits', '--output-format', 'text'],
            sessionIdAndDir: [
                '-p',
                '',
                '--permission-mode',
                'acceptEdits',
                '--resume',
                'abc123',
                '--output-format',
                'text',
            ],
            continueOnly: ['-p', '', '--permission-mode', 'acceptEdits', '--continue', '--output-format', 'text'],
        },
        {
            agent: 'codex',
            name: 'codex',
            fresh: ['exec', ''],
            // codex has no resume-by-id → session* set degrades to fresh exec
            sessionDirOnly: ['exec', ''],
            sessionIdAndDir: ['exec', ''],
            continueOnly: ['exec', 'resume', '--last'],
        },
        {
            agent: 'antigravity-cli',
            name: 'agy',
            fresh: ['-p', '', '--mode', 'accept-edits'],
            sessionDirOnly: ['-p', '', '--mode', 'accept-edits'],
            sessionIdAndDir: ['-p', '', '--mode', 'accept-edits', '--conversation', 'abc123'],
            continueOnly: ['-p', '', '--mode', 'accept-edits', '--continue'],
        },
        {
            agent: 'grok',
            name: 'grok',
            fresh: ['-p', '', '--allow', 'Write', '--allow', 'Edit', '--output-format', 'plain'],
            sessionDirOnly: ['-p', '', '--allow', 'Write', '--allow', 'Edit', '--output-format', 'plain'],
            sessionIdAndDir: [
                '-p',
                '',
                '--allow',
                'Write',
                '--allow',
                'Edit',
                '--resume',
                'abc123',
                '--output-format',
                'plain',
            ],
            continueOnly: ['-p', '', '--allow', 'Write', '--allow', 'Edit', '-c', '--output-format', 'plain'],
        },
    ];

    for (const c of cases) {
        const shim = getAgentShim(c.agent);

        test(`${c.name}: fresh open emits no resume/continue flags`, () => {
            expect(shim.getPromptCommand({ input: '' }).args).toEqual(c.fresh);
        });

        test(`${c.name}: sessionDir set → isolate path, never bare global continue`, () => {
            const args = shim.getPromptCommand({ input: '', sessionDir: '/run/sess', continue: true }).args;
            expect(args).toEqual(c.sessionDirOnly);
            expect(args).not.toContain('-c');
            expect(args).not.toContain('--continue');
            expect(args).not.toContain('resume');
            expect(args).not.toContain('--last');
        });

        test(`${c.name}: sessionId+sessionDir set → pin path, never bare global continue`, () => {
            const args = shim.getPromptCommand({
                input: '',
                sessionDir: '/run/sess',
                sessionId: 'abc123',
                continue: true,
            }).args;
            expect(args).toEqual(c.sessionIdAndDir);
            expect(args).not.toContain('-c');
            expect(args).not.toContain('--continue');
            expect(args).not.toContain('--last');
        });

        test(`${c.name}: continue-only (no session fields) keeps legacy resume-last`, () => {
            // input omitted: resume-last never carries a new prompt (codex rejects one).
            expect(shim.getPromptCommand({ continue: true }).args).toEqual(c.continueOnly);
        });
    }

    test('omp/pi omit --no-session when sessionDir is set (durable open — R4)', () => {
        for (const agent of ['omp', 'pi'] as AgentName[]) {
            const args = getAgentShim(agent).getPromptCommand({ input: '', sessionDir: '/run/sess' }).args;
            expect(args).not.toContain('--no-session');
            expect(args).toContain('--session-dir');
            expect(args).toContain('/run/sess');
        }
    });

    test('omp/pi still emit --no-session on the legacy fresh path', () => {
        for (const agent of ['omp', 'pi'] as AgentName[]) {
            const args = getAgentShim(agent).getPromptCommand({ input: '' }).args;
            expect(args).toContain('--no-session');
        }
    });
});
