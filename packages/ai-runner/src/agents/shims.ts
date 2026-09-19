import { getLogger } from '@gobing-ai/ts-infra';

/** Identifier for one supported coding agent (canonical id). */
export type AgentName =
    | 'claude'
    | 'codex'
    | 'gemini'
    | 'pi'
    | 'opencode'
    | 'antigravity-cli'
    | 'openclaw'
    | 'hermes'
    | 'omp'
    | 'grok'
    | 'deepseek';

/** Output mode for prompt invocations. */
export type OutputMode = 'text' | 'json';

/** Concrete executable and argv pair returned by an agent shim. */
export interface ShimCommand {
    /** Executable to invoke. */
    command: string;
    /** Arguments to pass to the executable. */
    args: string[];
}

/** Options for prompt-style invocations. */
export interface PromptOptions {
    /** Prompt text or slash command to send to the agent. */
    input?: string;
    /** Continue the previous session if the agent supports it. */
    continue?: boolean;
    /**
     * Pin a specific session to resume, when the agent supports resume-by-id
     * (see {@link getAgentSessionCapability}). Setting `sessionId` or `sessionDir`
     * selects the run-scoped session path and suppresses any unscoped global
     * continue/last-session flag (ADR-047 precedence R5).
     */
    sessionId?: string;
    /**
     * Isolate session storage into this directory (where the agent supports it).
     * Implies a durable session: agents with a session-store flag (omp/pi) must not
     * emit `--no-session` when this is set, so the session file is discoverable.
     */
    sessionDir?: string;
    /** Model identifier passed through to the agent CLI. */
    model?: string;
    /** Output mode passed through to the agent CLI. */
    mode?: OutputMode;
    /** Process timeout mirrored into CLIs that impose a shorter internal wait. */
    timeoutMs?: number;
    /** Team-mode purpose included in the identity preamble. */
    purpose?: string;
    /** Caller-defined prompt tags. */
    tags?: string[];
    /**
     * Dispatch working directory (project root). Agents whose headless file
     * tools resolve relative paths against a scratch workspace (antigravity-cli)
     * use this to re-root into the real workspace via their directory flag.
     */
    workspace?: string;
    /** Additional system prompt rendered in the identity preamble. */
    systemPrompt?: string;
    /** Current task identifier included in the identity preamble. */
    taskId?: string;
    /** Peer agents included in the identity preamble. */
    peers?: Array<{ id: string; type: string; purpose?: string }>;
    /**
     * Request the agent's persistent-stdin dispatch: argv starts a long-lived
     * process that reads framed prompts from stdin (one per line) instead of
     * consuming a one-shot `-p <input>` and exiting. Only shims exposing a
     * `persistentStdinProtocol` accept this — callers must consult
     * {@link getAgentSessionCapability}.`supportsPersistentStdin` first. In
     * persistent mode the shim omits `input` from argv entirely; the caller
     * writes the identity preamble / prompts via the shim's `frame` (see
     * `TeamAgentProcess` `stdinFramer`). rpc/stream-json modes supersede
     * `mode` (the structured-output flag rides inside the protocol).
     */
    persistentStdin?: boolean;
}

/** Frames one user prompt as a single stdin line for a persistent-stdin dispatch. */
export type StdinFrame = (input: string) => string;

/** pi-family rpc dialect (pi docs/rpc.md): one JSON object per line. */
const piRpcFrame: StdinFrame = (input) => `${JSON.stringify({ type: 'prompt', message: input })}\n`;

/** claude stream-json input dialect: one user-message JSONL envelope per line. */
const claudeStreamJsonFrame: StdinFrame = (input) =>
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: input }] } })}\n`;

/** Deprecation metadata attached to a retired or superseded agent shim. */
export interface AgentDeprecation {
    /** Release date (ISO) when the id was marked deprecated. */
    readonly since: string;
    /** Canonical replacement, when one exists. */
    readonly replacedBy?: AgentName;
}

/** Pure command builder for one coding-agent CLI. */
export interface AgentShim {
    /** Stable canonical agent identifier. */
    readonly name: AgentName;
    /** Executable command name. */
    readonly command: string;
    /** Capability tier: 1 = direct CLI, 2 = gateway/TUI constrained. */
    readonly tier: 1 | 2;
    /** Non-canonical ids that resolve to this shim (aliases map to this canonical id). */
    readonly aliases?: readonly string[];
    /** Deprecation marker; resolving a deprecated id warns and reports canonical status. */
    readonly deprecated?: AgentDeprecation;
    /** Build a help-display command. */
    getHelpCommand(): ShimCommand;
    /** Build a version-detection command. */
    getVersionCommand(): ShimCommand;
    /** Build a prompt invocation command. */
    getPromptCommand(options: PromptOptions): ShimCommand;
    /** Build an auth-status command, or null when unsupported. */
    getAuthCommand(): ShimCommand | null;
    /**
     * Persistent-stdin framing contract; present iff the shim wires a
     * stdin-listener dispatch (mirrors `supportsPersistentStdin`). Callers
     * frame every prompt (including the identity preamble) through it before
     * writing to the process stdin.
     */
    readonly persistentStdinProtocol?: { readonly frame: StdinFrame };
}

const claudeShim: AgentShim = {
    name: 'claude',
    command: 'claude',
    tier: 1,
    getHelpCommand: () => ({ command: 'claude', args: ['--help'] }),
    getVersionCommand: () => ({ command: 'claude', args: ['--version'] }),
    getPromptCommand: (options) => {
        // Headless dispatch cannot answer edit approval prompts. Keep the grant
        // scoped to file edits; shell and broader tools remain gated.
        // Persistent stdin rides the print path: `--input-format` only works
        // with --print, and stream-json input keeps the process alive reading
        // JSONL envelopes until stdin closes (verified --help, CLI 2.1.274).
        const persistent = options.persistentStdin === true;
        const args = persistent
            ? [
                  '-p',
                  '--input-format',
                  'stream-json',
                  '--permission-mode',
                  'acceptEdits',
                  '--allowedTools',
                  'Write',
                  'Edit',
              ]
            : ['-p', options.input ?? '', '--permission-mode', 'acceptEdits', '--allowedTools', 'Write', 'Edit'];
        const hasSession = options.sessionId !== undefined || options.sessionDir !== undefined;
        if (hasSession) {
            // Session/pin path — never emit --continue. Claude has no session-dir
            // flag; sessionDir is ignored (best-effort isolate).
            if (options.sessionId !== undefined) args.push('--resume', options.sessionId);
        } else if (options.continue === true) {
            args.push('--continue');
        }
        if (options.model !== undefined) args.push('--model', options.model);
        // stream-json output is part of the persistent protocol (the framing
        // assumes JSONL stdout); one-shot keeps the caller-requested mode.
        args.push('--output-format', persistent ? 'stream-json' : (options.mode ?? 'text'));
        return { command: 'claude', args };
    },
    getAuthCommand: () => ({ command: 'claude', args: ['auth', 'status'] }),
    persistentStdinProtocol: { frame: claudeStreamJsonFrame },
};

const codexShim: AgentShim = {
    name: 'codex',
    command: 'codex',
    tier: 1,
    getHelpCommand: () => ({ command: 'codex', args: ['--help'] }),
    getVersionCommand: () => ({ command: 'codex', args: ['--version'] }),
    getPromptCommand: (options) => {
        const hasSession = options.sessionId !== undefined || options.sessionDir !== undefined;
        if (options.continue === true && !hasSession && options.input !== undefined) {
            throw new Error('Codex resume mode does not accept a new prompt');
        }
        // Non-interactive resume-by-id (verified codex-cli 0.154.0): `exec resume
        // <id> <prompt>` continues the recorded thread headlessly — the former
        // interactive-picker-only gap is closed (feature B8 R3). sessionDir-only
        // still degrades to fresh exec (no session-dir flag); bare `continue`
        // stays `resume --last` (input omitted — resume-last rejects a prompt).
        const args =
            hasSession && options.sessionId !== undefined
                ? ['exec', 'resume', options.sessionId, options.input ?? '']
                : options.continue === true && !hasSession
                  ? ['exec', 'resume', '--last']
                  : ['exec', options.input ?? ''];
        if (options.model !== undefined) args.push('-m', options.model);
        if ((options.mode ?? 'text') === 'json') args.push('--json');
        return { command: 'codex', args };
    },
    getAuthCommand: () => ({ command: 'codex', args: ['login', 'status'] }),
};

const geminiShim: AgentShim = {
    name: 'gemini',
    command: 'gemini',
    tier: 1,
    deprecated: { since: '2026-06-20', replacedBy: 'antigravity-cli' },
    getHelpCommand: () => ({ command: 'gemini', args: ['--help'] }),
    getVersionCommand: () => ({ command: 'gemini', args: ['--version'] }),
    getPromptCommand: (options) => {
        const args = ['-p', options.input ?? ''];
        if (options.continue === true) args.push('-r', 'latest');
        if (options.model !== undefined) args.push('-m', options.model);
        args.push('-o', options.mode ?? 'text');
        return { command: 'gemini', args };
    },
    getAuthCommand: () => null,
};

const piShim: AgentShim = {
    name: 'pi',
    command: 'pi',
    tier: 1,
    getHelpCommand: () => ({ command: 'pi', args: ['--help'] }),
    getVersionCommand: () => ({ command: 'pi', args: ['--version'] }),
    getPromptCommand: (options) => {
        const args: string[] = [];
        const hasSession = options.sessionId !== undefined || options.sessionDir !== undefined;
        const persistent = options.persistentStdin === true;
        // Session/pin path: durable — never ephemeral --no-session, never global -c.
        if (!hasSession && !persistent && options.continue !== true) args.push('--no-session');
        // Persistent stdin: no -p positional (prompts arrive framed over stdin);
        // rpc mode is the long-lived listener (verified headless probe + pi
        // docs/rpc.md). It supersedes any text/json output mode.
        if (!persistent) args.push('-p', options.input ?? '');
        if (!hasSession && !persistent && options.continue === true) args.push('-c');
        if (options.sessionDir !== undefined) args.push('--session-dir', options.sessionDir);
        if (options.sessionId !== undefined) args.push('-r', options.sessionId);
        if (options.model !== undefined) args.push('--model', options.model);
        args.push('--mode', persistent ? 'rpc' : (options.mode ?? 'text'));
        return { command: 'pi', args };
    },
    getAuthCommand: () => ({ command: 'pi', args: ['--list-models'] }),
    persistentStdinProtocol: { frame: piRpcFrame },
};

const opencodeShim: AgentShim = {
    name: 'opencode',
    command: 'opencode',
    tier: 1,
    getHelpCommand: () => ({ command: 'opencode', args: ['--help'] }),
    getVersionCommand: () => ({ command: 'opencode', args: ['--version'] }),
    getPromptCommand: (options) => {
        const args = ['run', options.input ?? ''];
        if (options.continue === true) args.push('-c');
        if (options.model !== undefined) args.push('-m', options.model);
        if ((options.mode ?? 'text') === 'json') args.push('--format', 'json');
        return { command: 'opencode', args };
    },
    getAuthCommand: () => ({ command: 'opencode', args: ['providers'] }),
};

/**
 * Antigravity CLI (`agy`) — the scriptable/headless successor to Gemini CLI
 * (Antigravity 2.0 split, 2026-06). Tier-1: `-p`/`--print` one-shot, `--model`,
 * `agy models`, `--continue` resumes the most recent session.
 */
const antigravityCliShim: AgentShim = {
    name: 'antigravity-cli',
    command: 'agy',
    tier: 1,
    aliases: ['antigravity', 'agy'],
    getHelpCommand: () => ({ command: 'agy', args: ['--help'] }),
    getVersionCommand: () => ({ command: 'agy', args: ['--version'] }),
    getPromptCommand: (options) => {
        // Print mode is headless: agy auto-denies any tool that would prompt
        // (write_file et al.), so expectFile-style automation dead-ends without
        // a permission affordance (spur 0689). `--mode accept-edits` is the
        // narrowest grant verified to suppress the denial (live probe
        // 2026-08-27: write_file succeeds, multi-step write-read-write passes);
        // it auto-approves edit permission requests only, not all tools. Trust
        // assumption: the dispatch is already an operator-initiated, headless,
        // workspace-scoped subprocess running agent-emitted commands under the
        // caller's supervision. This is the narrow edit-only policy shared by
        // configured headless executors that otherwise prompt (spur 0689).
        const args = ['-p', options.input ?? '', '--mode', 'accept-edits'];
        if (options.timeoutMs !== undefined) args.push('--print-timeout', `${options.timeoutMs}ms`);
        // Headless agy resolves relative file-tool paths against a scratch dir,
        // not the process cwd; --add-dir re-roots them into the real workspace
        // (spur 0689, verified: without it expectFile artifacts land in scratch).
        if (options.workspace !== undefined) args.push('--add-dir', options.workspace);
        const hasSession = options.sessionId !== undefined || options.sessionDir !== undefined;
        if (hasSession) {
            // Session/pin path — never emit --continue. agy has no session-dir flag;
            // sessionDir is ignored (best-effort isolate).
            if (options.sessionId !== undefined) args.push('--conversation', options.sessionId);
        } else if (options.continue === true) {
            args.push('--continue');
        }
        if (options.model !== undefined) args.push('--model', options.model);
        return { command: 'agy', args };
    },
    getAuthCommand: () => null,
};

const openclawShim: AgentShim = {
    name: 'openclaw',
    command: 'openclaw',
    tier: 2,
    getHelpCommand: () => ({ command: 'openclaw', args: ['--help'] }),
    getVersionCommand: () => ({ command: 'openclaw', args: ['--version'] }),
    getPromptCommand: (options) => ({ command: 'openclaw', args: ['agent', '--local', '-m', options.input ?? ''] }),
    getAuthCommand: () => ({ command: 'openclaw', args: ['health'] }),
};

/**
 * Hermes Agent (NousResearch) — OpenClaw-compatible coding agent. One-shot via
 * `hermes chat -q <input>`; model/provider overrides; `hermes doctor` health probe.
 */
const hermesShim: AgentShim = {
    name: 'hermes',
    command: 'hermes',
    tier: 1,
    getHelpCommand: () => ({ command: 'hermes', args: ['chat', '--help'] }),
    getVersionCommand: () => ({ command: 'hermes', args: ['--version'] }),
    getPromptCommand: (options) => {
        const args = ['chat', '-q', options.input ?? ''];
        if (options.continue === true) args.push('--continue');
        if (options.model !== undefined) args.push('-m', options.model);
        return { command: 'hermes', args };
    },
    getAuthCommand: () => ({ command: 'hermes', args: ['doctor'] }),
};

/**
 * omp (oh-my-pi) — a Pi fork. argv is Pi-compatible for the one-shot surface
 * (`--no-session`, `-p`, `-c`, `--model`, `--mode`); speaks Pi's `/skill:` slash dialect.
 */
const ompShim: AgentShim = {
    name: 'omp',
    command: 'omp',
    tier: 1,
    getHelpCommand: () => ({ command: 'omp', args: ['--help'] }),
    getVersionCommand: () => ({ command: 'omp', args: ['--version'] }),
    getPromptCommand: (options) => {
        const args: string[] = [];
        const hasSession = options.sessionId !== undefined || options.sessionDir !== undefined;
        const persistent = options.persistentStdin === true;
        // Session/pin path: durable — never ephemeral --no-session, never global -c.
        if (!hasSession && !persistent && options.continue !== true) args.push('--no-session');
        // Persistent stdin mirrors pi (omp is a pi fork; same rpc dialect) —
        // verified `--mode rpc` in `omp --help` at the pi-compatible surface.
        if (!persistent) args.push('-p', options.input ?? '');
        if (!hasSession && !persistent && options.continue === true) args.push('-c');
        if (options.sessionDir !== undefined) args.push('--session-dir', options.sessionDir);
        if (options.sessionId !== undefined) args.push('-r', options.sessionId);
        if (options.model !== undefined) args.push('--model', options.model);
        args.push('--mode', persistent ? 'rpc' : (options.mode ?? 'text'));
        return { command: 'omp', args };
    },
    getAuthCommand: () => ({ command: 'omp', args: ['--list-models'] }),
    persistentStdinProtocol: { frame: piRpcFrame },
};

/**
 * Grok Build CLI (`grok`) — xAI coding agent. Headless one-shot via `-p`/`--single`;
 * continue with `-c`; model via `-m`. Output formats are `plain`/`json`/`streaming-json`
 * (map ai-runner `text` → `plain`). No auth-status verb — `getAuthCommand` is null;
 * credential probing lives in auth-shims (env / `~/.grok/auth.json`).
 */
const grokShim: AgentShim = {
    name: 'grok',
    command: 'grok',
    tier: 1,
    getHelpCommand: () => ({ command: 'grok', args: ['--help'] }),
    getVersionCommand: () => ({ command: 'grok', args: ['--version'] }),
    getPromptCommand: (options) => {
        // Grok 1.0.5 accepts --permission-mode acceptEdits but still narrates
        // writes without invoking the tool in single-turn mode. Tool-scoped
        // allow rules are the narrow verified noninteractive affordance.
        const args = ['-p', options.input ?? '', '--allow', 'Write', '--allow', 'Edit'];
        const hasSession = options.sessionId !== undefined || options.sessionDir !== undefined;
        if (hasSession) {
            // Session/pin path — never emit -c. grok has no session-dir flag;
            // sessionDir is ignored (best-effort isolate).
            if (options.sessionId !== undefined) args.push('--resume', options.sessionId);
        } else if (options.continue === true) {
            args.push('-c');
        }
        if (options.model !== undefined) args.push('-m', options.model);
        // Grok has no `text` format; map ai-runner OutputMode `text` → `plain`.
        const format = (options.mode ?? 'text') === 'json' ? 'json' : 'plain';
        args.push('--output-format', format);
        return { command: 'grok', args };
    },
    getAuthCommand: () => null,
};

/**
 * DeepSeek coding agent (`dsh`, @deepseek-ai/dsh) — tier-1. Boot model is
 * `dsh --profile <name>`; the headless one-shot surface is the `headless`
 * profile: `dsh --profile headless "<task>"` streams reasoning to stderr and
 * prints the final assistant message to stdout. At 0.1.5-rc.1 the headless
 * app accepts only the positional task and `-h` — no resume/model/mode flags.
 * No auth subcommand; credentials resolve via env references / `~/.dsh`.
 */
const dshShim: AgentShim = {
    name: 'deepseek',
    command: 'dsh',
    tier: 1,
    getHelpCommand: () => ({ command: 'dsh', args: ['--help'] }),
    getVersionCommand: () => ({ command: 'dsh', args: ['--version'] }),
    getPromptCommand: (options) => {
        // Always a fresh one-shot headless dispatch: sessionId/sessionDir/
        // continue/model degrade silently — the HEADLESS app takes only the
        // task + `-h`; no resume/model flags exist at dsh 0.1.5-rc.1.
        // mode/workspace/timeoutMs have no dsh flag — best-effort ignored.
        return { command: 'dsh', args: ['--profile', 'headless', options.input ?? ''] };
    },
    getAuthCommand: () => null,
};

/** All bundled agent shims keyed by canonical agent name. */
export const AGENT_SHIMS: Readonly<Record<AgentName, AgentShim>> = {
    claude: claudeShim,
    codex: codexShim,
    gemini: geminiShim,
    pi: piShim,
    opencode: opencodeShim,
    'antigravity-cli': antigravityCliShim,
    openclaw: openclawShim,
    hermes: hermesShim,
    omp: ompShim,
    grok: grokShim,
    deepseek: dshShim,
};

/** Session-affinity capability for one coding agent (ADR-047). */
export interface AgentSessionCapability {
    /** Can resume a specific prior session by id (e.g. `-r <id>` / `--resume <id>`). */
    readonly supportsResumeById: boolean;
    /** Can isolate session storage into a caller-supplied directory. */
    readonly supportsSessionDir: boolean;
    /** Multi-turn conversation over stdin in one process (e.g. `--input-format stream-json`, `--mode rpc`). */
    readonly supportsPersistentStdin: boolean;
    /** Structured machine-readable output mode (json / stream-json). */
    readonly supportsStructuredOutput: boolean;
    /** Agent CLI version this row was last verified against; `'unverified …'` when the CLI was absent. */
    readonly verifiedAgainst: string;
    /** Recorded reason for any `false` — a CLI gap, or a CLI-supported flag the shim argv does not wire yet. */
    readonly note?: string;
}

/**
 * Session-affinity capability metadata per agent. Callers must consult this
 * instead of inventing per-agent argv: when `sessionDir`/`sessionId` are set,
 * `supportsResumeById` decides resume-by-id vs fresh-degrade, and
 * `supportsSessionDir` decides whether `sessionDir` is honored (ADR-047 R2).
 *
 * Each row records what the agent CLI verifiably supports at the version named
 * in `verifiedAgainst` (probed via `<agent> --help` / documented flags; feature
 * B8). Every `false` carries a `note` naming the gap — an unexplained `false`
 * is a defect — and a CLI-supported flag the shim argv does not wire yet is
 * called out in the note instead of being silently degraded or guessed `true`.
 * CLIs that were absent on the probing host carry `verifiedAgainst:
 * 'unverified …'`, never a fabricated version.
 */
const AGENT_SESSION_CAPABILITY: Readonly<Record<AgentName, AgentSessionCapability>> = {
    omp: {
        supportsResumeById: true,
        supportsSessionDir: true,
        supportsPersistentStdin: true,
        supportsStructuredOutput: true,
        verifiedAgainst: '18.2.3',
    },
    pi: {
        supportsResumeById: true,
        supportsSessionDir: true,
        supportsPersistentStdin: true,
        supportsStructuredOutput: true,
        verifiedAgainst: '0.85.1',
    },
    claude: {
        supportsResumeById: true,
        supportsSessionDir: false,
        supportsPersistentStdin: true,
        supportsStructuredOutput: true,
        verifiedAgainst: '2.1.274',
        // Persistent stdin is shim-wired: `-p --input-format stream-json --output-format
        // stream-json` keeps the process alive reading JSONL envelopes (verified --help;
        // --input-format only works with --print).
        note: 'no session-dir flag — sessionDir is ignored (best-effort isolate)',
    },
    codex: {
        supportsResumeById: true,
        supportsSessionDir: false,
        supportsPersistentStdin: false,
        supportsStructuredOutput: true,
        verifiedAgainst: '0.154.0',
        // R3 branch 2: `exec resume <id> <prompt>` is the working non-interactive
        // resume (verified 0.154.0) — wired in getPromptCommand below.
        note: 'no session-dir flag — sessionDir is ignored; `exec` carries one prompt arg (stdin `-` is one-shot), so no multi-turn stdin',
    },
    'antigravity-cli': {
        supportsResumeById: true,
        supportsSessionDir: false,
        supportsPersistentStdin: false,
        supportsStructuredOutput: false,
        verifiedAgainst: 'unverified (CLI not installed)',
        // resume-by-id is provenance from the shim's own `--conversation <id>`
        // argv, not a guess; agy itself was absent at verification (2026-09-18).
        note: 'resume-by-id per the shim’s documented --conversation <id> argv; agy absent at verification (2026-09-18) — no session-dir, stdin, or structured-output flags documented',
    },
    grok: {
        supportsResumeById: true,
        supportsSessionDir: false,
        supportsPersistentStdin: false,
        supportsStructuredOutput: true,
        verifiedAgainst: '1.0.34',
        note: 'no session-dir flag — sessionDir is ignored (best-effort isolate); no multi-turn stdin input mode',
    },
    gemini: {
        supportsResumeById: false,
        supportsSessionDir: false,
        supportsPersistentStdin: false,
        supportsStructuredOutput: true,
        verifiedAgainst: '0.46.0',
        note: '`-r/--resume` accepts `latest` or a `--list-sessions` index, not a session id; no session-dir flag; no stdin input mode',
    },
    opencode: {
        supportsResumeById: false,
        supportsSessionDir: false,
        supportsPersistentStdin: false,
        supportsStructuredOutput: true,
        verifiedAgainst: '1.17.15',
        note: 'CLI `run -s/--session <id>` supports resume-by-id but the shim argv does not wire it yet (follow-up before declaring true); no session-dir flag; no stdin input mode',
    },
    openclaw: {
        supportsResumeById: false,
        supportsSessionDir: false,
        supportsPersistentStdin: false,
        supportsStructuredOutput: true,
        verifiedAgainst: '2026.6.11',
        note: 'CLI `agent --session-id <id>` and `--json` are not yet shim-wired (follow-up before declaring resume-by-id true); gateway turns have no persistent stdin',
    },
    hermes: {
        supportsResumeById: false,
        supportsSessionDir: false,
        supportsPersistentStdin: false,
        supportsStructuredOutput: false,
        verifiedAgainst: 'unverified (CLI not installed)',
        note: 'CLI absent at verification (2026-09-18) — conservative defaults; `chat --continue` resumes the last session only, no session-dir/stdin/structured-output flags documented',
    },
    // dsh headless has no resume/session flags — fresh-dispatch degrade.
    deepseek: {
        supportsResumeById: false,
        supportsSessionDir: false,
        supportsPersistentStdin: false,
        supportsStructuredOutput: false,
        verifiedAgainst: '0.1.5-rc.1',
        note: 'headless app takes only the task positional and -h at 0.1.5-rc.1 — no resume/session/mode flags; fresh-dispatch degrade',
    },
};

/** Query a bundled agent's session-affinity capability by canonical name. */
export function getAgentSessionCapability(agent: AgentName): AgentSessionCapability {
    return AGENT_SESSION_CAPABILITY[agent];
}

/** Tier-1 auto-selection priority. Deprecated ids are excluded. */
export const TIER1_PRIORITY: readonly AgentName[] = [
    'pi',
    'omp',
    'codex',
    'antigravity-cli',
    'claude',
    'hermes',
    'opencode',
    'grok',
    'deepseek',
];

/** Display order for doctor and list commands. */
export const DISPLAY_ORDER: readonly AgentName[] = [
    'claude',
    'codex',
    'gemini',
    'pi',
    'omp',
    'opencode',
    'antigravity-cli',
    'openclaw',
    'hermes',
    'grok',
    'deepseek',
];

/** Set of gateway/TUI-constrained agents. */
export const TIER2_AGENTS: ReadonlySet<AgentName> = new Set(['openclaw']);

/** Logger for alias/deprecation resolution diagnostics. */
const logger = getLogger('ai-runner.shims');

/** Alias → canonical id, derived once from `AGENT_SHIMS[*].aliases`. */
const ALIAS_TO_CANONICAL: Readonly<Record<string, AgentName>> = Object.fromEntries(
    Object.values(AGENT_SHIMS).flatMap((shim) => (shim.aliases ?? []).map((alias) => [alias, shim.name] as const)),
);

/**
 * Resolve a canonical or alias id to its canonical `AgentName`.
 *
 * - Canonical ids resolve to themselves.
 * - Aliases resolve to their canonical id (e.g. `'antigravity' → 'antigravity-cli'`).
 * - Unknown ids resolve to `undefined`.
 *
 * Resolving a deprecated or aliased id emits exactly one `warn` through the
 * logger seam and never throws.
 */
export function resolveAgentName(input: string): AgentName | undefined {
    if (isCanonicalName(input)) return input;
    const canonical = ALIAS_TO_CANONICAL[input];
    if (canonical !== undefined) {
        warnDeprecatedOrAlias(input, canonical);
        return canonical;
    }
    return undefined;
}

/** Return true when a value is a known canonical id or alias. Does not narrow;
 * use `resolveAgentName()` to obtain the canonical `AgentName`. */
export function isAgentName(value: string): boolean {
    return isCanonicalName(value) || value in ALIAS_TO_CANONICAL;
}

/** Look up a bundled agent shim, resolving aliases to the canonical shim. */
export function getAgentShim(agent: AgentName): AgentShim {
    const canonical = resolveAgentName(agent);
    if (canonical === undefined) {
        throw new Error(`Unsupported agent: ${agent}`);
    }
    return AGENT_SHIMS[canonical];
}

function isCanonicalName(value: string): value is AgentName {
    return Object.hasOwn(AGENT_SHIMS, value);
}

function warnDeprecatedOrAlias(input: string, canonical: AgentName): void {
    const shim = AGENT_SHIMS[canonical];
    if (shim.deprecated !== undefined) {
        const replacement = shim.deprecated.replacedBy ?? canonical;
        logger.warn(`agent '${input}' is deprecated (since ${shim.deprecated.since}); use '${replacement}'`, {
            input,
            canonical,
            replacedBy: replacement,
        });
    } else {
        logger.warn(`agent '${input}' is an alias; resolving to canonical '${canonical}'`, { input, canonical });
    }
}
