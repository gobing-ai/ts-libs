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
        expect(isAgentName('deepseek')).toBe(true);
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
        expect(DISPLAY_ORDER).toContain('deepseek');
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

describe('getAgentSessionCapability (0447 R2 + B8 R1/R3)', () => {
    test('omp and pi fully support resume-by-id, session-dir, stdin, structured output', () => {
        expect(getAgentSessionCapability('omp')).toEqual({
            supportsResumeById: true,
            supportsSessionDir: true,
            supportsPersistentStdin: true,
            supportsStructuredOutput: true,
            verifiedAgainst: '18.2.3',
        });
        expect(getAgentSessionCapability('pi').verifiedAgainst).toBe('0.85.1');
    });

    test('claude supports resume-by-id and structured output but no session-dir (B8 R4)', () => {
        const cap = getAgentSessionCapability('claude');
        expect(cap.supportsResumeById).toBe(true);
        expect(cap.supportsSessionDir).toBe(false);
        expect(cap.supportsStructuredOutput).toBe(true);
        // Session id is discovered from output (discoverSessionId contract), not
        // from a caller-owned session dir — the note records the ignore.
        expect(cap.note).toContain('sessionDir is ignored');
        expect(cap.verifiedAgainst).toBe('2.1.274');
    });

    test('codex resumes by id via the non-interactive `exec resume <id>` (B8 R3)', () => {
        const cap = getAgentSessionCapability('codex');
        expect(cap.supportsResumeById).toBe(true);
        expect(cap.supportsSessionDir).toBe(false);
        // R3 branch 2 (true + wired): the non-interactive resume command itself is
        // proven by the argv matrix below (`exec resume <id> <prompt>`).
        expect(cap.verifiedAgainst).toBe('0.154.0');
    });

    test('agy and grok support resume-by-id, no session-dir', () => {
        const agy = getAgentSessionCapability('antigravity-cli');
        expect(agy.supportsResumeById).toBe(true);
        expect(agy.supportsSessionDir).toBe(false);
        expect(agy.verifiedAgainst).toMatch(/^unverified/);
        const grok = getAgentSessionCapability('grok');
        expect(grok.supportsResumeById).toBe(true);
        expect(grok.supportsSessionDir).toBe(false);
        expect(grok.verifiedAgainst).toBe('1.0.34');
    });

    test('gemini has no resume-by-id (`-r` is latest/index only) but has structured output', () => {
        const cap = getAgentSessionCapability('gemini');
        expect(cap.supportsResumeById).toBe(false);
        expect(cap.note).toContain('--list-sessions');
        expect(cap.supportsStructuredOutput).toBe(true);
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
            fresh: [
                '-p',
                '',
                '--permission-mode',
                'acceptEdits',
                '--allowedTools',
                'Write',
                'Edit',
                '--output-format',
                'text',
            ],
            // sessionDir unsupported → ignored; sessionId pins via --resume
            sessionDirOnly: [
                '-p',
                '',
                '--permission-mode',
                'acceptEdits',
                '--allowedTools',
                'Write',
                'Edit',
                '--output-format',
                'text',
            ],
            sessionIdAndDir: [
                '-p',
                '',
                '--permission-mode',
                'acceptEdits',
                '--allowedTools',
                'Write',
                'Edit',
                '--resume',
                'abc123',
                '--output-format',
                'text',
            ],
            continueOnly: [
                '-p',
                '',
                '--permission-mode',
                'acceptEdits',
                '--allowedTools',
                'Write',
                'Edit',
                '--continue',
                '--output-format',
                'text',
            ],
        },
        {
            agent: 'codex',
            name: 'codex',
            fresh: ['exec', ''],
            // codex 0.154.0: non-interactive `exec resume <id> <prompt>` (B8 R3) —
            // the session pin works; sessionDir-only still degrades to fresh exec
            // (no session-dir flag).
            sessionDirOnly: ['exec', ''],
            sessionIdAndDir: ['exec', 'resume', 'abc123', ''],
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

describe('deepseek shim (task 0066)', () => {
    test('deepseek is a known canonical id resolving to the dsh shim', () => {
        expect(isAgentName('deepseek')).toBe(true);
        expect(resolveAgentName('deepseek')).toBe('deepseek');
        const shim = getAgentShim('deepseek');
        expect(shim.name).toBe('deepseek');
        expect(shim.command).toBe('dsh');
        expect(shim.tier).toBe(1);
        expect(shim.getHelpCommand()).toEqual({ command: 'dsh', args: ['--help'] });
        expect(shim.getVersionCommand()).toEqual({ command: 'dsh', args: ['--version'] });
    });

    test('getPromptCommand maps input to dsh headless one-shot argv', () => {
        expect(getAgentShim('deepseek').getPromptCommand({ input: 'run the tests' })).toEqual({
            command: 'dsh',
            args: ['--profile', 'headless', 'run the tests'],
        });
    });

    test('session/continue/model options degrade to a fresh headless one-shot without error', () => {
        const shim = getAgentShim('deepseek');
        const expected = { command: 'dsh', args: ['--profile', 'headless', 'fix the bug'] };
        expect(shim.getPromptCommand({ input: 'fix the bug', sessionId: 's1' })).toEqual(expected);
        expect(shim.getPromptCommand({ input: 'fix the bug', sessionDir: '/tmp/s' })).toEqual(expected);
        expect(shim.getPromptCommand({ input: 'fix the bug', continue: true })).toEqual(expected);
        expect(shim.getPromptCommand({ input: 'fix the bug', model: 'deepseek-chat' })).toEqual(expected);
    });

    test('getAuthCommand is null (no auth subcommand)', () => {
        expect(getAgentShim('deepseek').getAuthCommand()).toBeNull();
    });

    test('deepseek has no resume-by-id and no session-dir (fresh degrade)', () => {
        expect(getAgentSessionCapability('deepseek')).toEqual({
            supportsResumeById: false,
            supportsSessionDir: false,
            supportsPersistentStdin: false,
            supportsStructuredOutput: false,
            verifiedAgainst: '0.1.5-rc.1',
            note: expect.any(String),
        });
    });

    // B8 R1/R2/R5: every AgentName resolves a complete, verified record — shape,
    // boolean enum, non-empty version provenance, and an explained `false`.
    describe('AgentSessionCapability matrix (B8 R5)', () => {
        const REQUIRED_BOOLEAN_FIELDS = [
            'supportsResumeById',
            'supportsSessionDir',
            'supportsPersistentStdin',
            'supportsStructuredOutput',
        ] as const;

        test('every agent resolves a complete record (shape + enum + provenance)', () => {
            for (const name of Object.keys(AGENT_SHIMS) as AgentName[]) {
                const cap = getAgentSessionCapability(name);
                for (const field of REQUIRED_BOOLEAN_FIELDS) {
                    expect(typeof cap[field]).toBe('boolean');
                    expect([true, false]).toContain(cap[field]);
                }
                expect(typeof cap.verifiedAgainst).toBe('string');
                expect(cap.verifiedAgainst.length).toBeGreaterThan(0);
            }
        });

        test('every `false` is explained by a non-empty note (no silent degradation)', () => {
            for (const name of Object.keys(AGENT_SHIMS) as AgentName[]) {
                const cap = getAgentSessionCapability(name);
                const hasFalse = REQUIRED_BOOLEAN_FIELDS.some((field) => !cap[field]);
                if (hasFalse) {
                    expect(cap.note).toBeDefined();
                    expect(cap.note?.length ?? 0).toBeGreaterThan(0);
                }
            }
        });

        test('unverified rows never carry a fabricated CLI version', () => {
            for (const name of Object.keys(AGENT_SHIMS) as AgentName[]) {
                const cap = getAgentSessionCapability(name);
                if (cap.verifiedAgainst.startsWith('unverified')) {
                    expect(cap.note).toBeDefined();
                } else {
                    // Real rows carry the probed CLI version (e.g. `2.1.274`).
                    expect(cap.verifiedAgainst).toMatch(/^\d/);
                }
            }
        });
    });
});

describe('persistent-stdin dispatch (feature B8 upstream)', () => {
    test('pi/omp persistent argv: no -p positional, rpc mode, durable session flags kept', () => {
        for (const name of ['pi', 'omp'] as const) {
            const shim = getAgentShim(name);
            // Persistent with pinned session — no --no-session, no -c, rpc wins over mode.
            expect(
                shim.getPromptCommand({
                    persistentStdin: true,
                    mode: 'json',
                    sessionId: 's1',
                    sessionDir: '/tmp/sd',
                    model: 'm',
                }),
            ).toEqual({
                command: name,
                args: ['--session-dir', '/tmp/sd', '-r', 's1', '--model', 'm', '--mode', 'rpc'],
            });
            // Persistent without session: no --no-session, no -c, no input echo.
            expect(shim.getPromptCommand({ persistentStdin: true }).args).toEqual(['--mode', 'rpc']);
        }
    });

    test('claude persistent argv: stream-json input on the print path, no prompt positional', () => {
        const shim = getAgentShim('claude');
        expect(
            shim.getPromptCommand({
                persistentStdin: true,
                input: 'ignored-in-persistent',
                sessionId: 's1',
                model: 'opus',
            }),
        ).toEqual({
            command: 'claude',
            args: [
                '-p',
                '--input-format',
                'stream-json',
                '--permission-mode',
                'acceptEdits',
                '--allowedTools',
                'Write',
                'Edit',
                '--resume',
                's1',
                '--model',
                'opus',
                '--output-format',
                'stream-json',
            ],
        });
    });

    test('persistentStdinProtocol framing produces single-line JSON prompts', () => {
        const piFrame = getAgentShim('pi').persistentStdinProtocol?.frame;
        expect(JSON.parse(piFrame?.('say ok') ?? '')).toEqual({ type: 'prompt', message: 'say ok' });
        expect(piFrame?.('line1\nline2').endsWith('\n')).toBe(true);

        const claudeFrame = getAgentShim('claude').persistentStdinProtocol?.frame;
        expect(JSON.parse(claudeFrame?.('hi') ?? '')).toEqual({
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        });

        // omp shares the pi rpc dialect; shims without wiring expose no protocol.
        expect(getAgentShim('omp').persistentStdinProtocol?.frame).toBe(piFrame);
        expect(getAgentShim('codex').persistentStdinProtocol).toBeUndefined();
    });

    test('persistentStdin capability rows stay honest about wired shims', () => {
        for (const name of ['pi', 'omp', 'claude'] as const) {
            expect(getAgentSessionCapability(name)?.supportsPersistentStdin).toBe(true);
            expect(getAgentShim(name).persistentStdinProtocol).toBeDefined();
        }
    });
});
