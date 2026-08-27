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
    | 'grok';

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
}

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
}

const claudeShim: AgentShim = {
    name: 'claude',
    command: 'claude',
    tier: 1,
    getHelpCommand: () => ({ command: 'claude', args: ['--help'] }),
    getVersionCommand: () => ({ command: 'claude', args: ['--version'] }),
    getPromptCommand: (options) => {
        const args = ['-p', options.input ?? ''];
        const hasSession = options.sessionId !== undefined || options.sessionDir !== undefined;
        if (hasSession) {
            // Session/pin path — never emit --continue. Claude has no session-dir
            // flag; sessionDir is ignored (best-effort isolate).
            if (options.sessionId !== undefined) args.push('--resume', options.sessionId);
        } else if (options.continue === true) {
            args.push('--continue');
        }
        if (options.model !== undefined) args.push('--model', options.model);
        args.push('--output-format', options.mode ?? 'text');
        return { command: 'claude', args };
    },
    getAuthCommand: () => ({ command: 'claude', args: ['auth', 'status'] }),
};

const codexShim: AgentShim = {
    name: 'codex',
    command: 'codex',
    tier: 1,
    getHelpCommand: () => ({ command: 'codex', args: ['--help'] }),
    getVersionCommand: () => ({ command: 'codex', args: ['--version'] }),
    getPromptCommand: (options) => {
        const hasSession = options.sessionId !== undefined || options.sessionDir !== undefined;
        // Session/pin path degrades to a fresh `exec` — codex has no reliable
        // one-shot resume-by-id, so never `exec resume --last` (no global last).
        if (options.continue === true && !hasSession && options.input !== undefined) {
            throw new Error('Codex resume mode does not accept a new prompt');
        }
        const args =
            options.continue === true && !hasSession ? ['exec', 'resume', '--last'] : ['exec', options.input ?? ''];
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
        // Session/pin path: durable — never ephemeral --no-session, never global -c.
        if (!hasSession && options.continue !== true) args.push('--no-session');
        args.push('-p', options.input ?? '');
        if (!hasSession && options.continue === true) args.push('-c');
        if (options.sessionDir !== undefined) args.push('--session-dir', options.sessionDir);
        if (options.sessionId !== undefined) args.push('-r', options.sessionId);
        if (options.model !== undefined) args.push('--model', options.model);
        args.push('--mode', options.mode ?? 'text');
        return { command: 'pi', args };
    },
    getAuthCommand: () => ({ command: 'pi', args: ['--list-models'] }),
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
        // this flag (spur 0689). Trust assumption: the dispatch is already an
        // unsandboxed subprocess running agent-emitted commands under the
        // caller's supervision — the prompt is a UX layer, not a boundary.
        const args = ['-p', options.input ?? '', '--dangerously-skip-permissions'];
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
        // Session/pin path: durable — never ephemeral --no-session, never global -c.
        if (!hasSession && options.continue !== true) args.push('--no-session');
        args.push('-p', options.input ?? '');
        if (!hasSession && options.continue === true) args.push('-c');
        if (options.sessionDir !== undefined) args.push('--session-dir', options.sessionDir);
        if (options.sessionId !== undefined) args.push('-r', options.sessionId);
        if (options.model !== undefined) args.push('--model', options.model);
        args.push('--mode', options.mode ?? 'text');
        return { command: 'omp', args };
    },
    getAuthCommand: () => ({ command: 'omp', args: ['--list-models'] }),
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
        const args = ['-p', options.input ?? ''];
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
};

/** Session-affinity capability for one coding agent (ADR-047). */
export interface AgentSessionCapability {
    /** Can resume a specific prior session by id (e.g. `-r <id>` / `--resume <id>`). */
    readonly supportsResumeById: boolean;
    /** Can isolate session storage into a caller-supplied directory. */
    readonly supportsSessionDir: boolean;
}

/**
 * Session-affinity capability metadata per agent. Callers must consult this
 * instead of inventing per-agent argv: when `sessionDir`/`sessionId` are set,
 * `supportsResumeById` decides resume-by-id vs fresh-degrade, and
 * `supportsSessionDir` decides whether `sessionDir` is honored (ADR-047 R2).
 *
 * Agents not in the six-agent affinity matrix default to no resume-by-id and no
 * session-dir — they get the isolated-fresh / no-resume degrade.
 */
const AGENT_SESSION_CAPABILITY: Readonly<Record<AgentName, AgentSessionCapability>> = {
    omp: { supportsResumeById: true, supportsSessionDir: true },
    pi: { supportsResumeById: true, supportsSessionDir: true },
    claude: { supportsResumeById: true, supportsSessionDir: false },
    // codex resume is interactive-only (`exec resume` picker); no one-shot
    // resume-by-id and no session-dir — degrades to fresh exec.
    codex: { supportsResumeById: false, supportsSessionDir: false },
    'antigravity-cli': { supportsResumeById: true, supportsSessionDir: false },
    grok: { supportsResumeById: true, supportsSessionDir: false },
    // Non-matrix agents: conservative default (isolated-fresh / no-resume).
    gemini: { supportsResumeById: false, supportsSessionDir: false },
    opencode: { supportsResumeById: false, supportsSessionDir: false },
    openclaw: { supportsResumeById: false, supportsSessionDir: false },
    hermes: { supportsResumeById: false, supportsSessionDir: false },
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
