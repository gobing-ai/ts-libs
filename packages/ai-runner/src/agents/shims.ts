/** Identifier for one supported coding agent. */
export type AgentName = 'claude' | 'codex' | 'gemini' | 'pi' | 'opencode' | 'antigravity' | 'openclaw';

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
    /** Model identifier passed through to the agent CLI. */
    model?: string;
    /** Output mode passed through to the agent CLI. */
    mode?: OutputMode;
    /** Team-mode purpose included in the identity preamble. */
    purpose?: string;
    /** Caller-defined prompt tags. */
    tags?: string[];
    /** Additional system prompt rendered in the identity preamble. */
    systemPrompt?: string;
    /** Current task identifier included in the identity preamble. */
    taskId?: string;
    /** Peer agents included in the identity preamble. */
    peers?: Array<{ id: string; type: string; purpose?: string }>;
}

/** Pure command builder for one coding-agent CLI. */
export interface AgentShim {
    /** Stable agent identifier. */
    readonly name: AgentName;
    /** Executable command name. */
    readonly command: string;
    /** Capability tier: 1 = direct CLI, 2 = gateway/TUI constrained. */
    readonly tier: 1 | 2;
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
        if (options.continue === true) args.push('--continue');
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
        if (options.continue === true && options.input !== undefined) {
            throw new Error('Codex resume mode does not accept a new prompt');
        }
        const args = options.continue === true ? ['exec', 'resume', '--last'] : ['exec', options.input ?? ''];
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
        if (options.continue !== true) args.push('--no-session');
        args.push('-p', options.input ?? '');
        if (options.continue === true) args.push('-c');
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

const antigravityShim: AgentShim = {
    name: 'antigravity',
    command: 'agy',
    tier: 2,
    getHelpCommand: () => ({ command: 'agy', args: ['--help'] }),
    getVersionCommand: () => ({ command: 'agy', args: ['--version'] }),
    getPromptCommand: (options) => ({ command: 'agy', args: ['chat', options.input ?? ''] }),
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

/** All bundled agent shims keyed by agent name. */
export const AGENT_SHIMS: Readonly<Record<AgentName, AgentShim>> = {
    claude: claudeShim,
    codex: codexShim,
    gemini: geminiShim,
    pi: piShim,
    opencode: opencodeShim,
    antigravity: antigravityShim,
    openclaw: openclawShim,
};

/** Tier-1 auto-selection priority. */
export const TIER1_PRIORITY: readonly AgentName[] = ['pi', 'codex', 'gemini', 'claude', 'opencode'];

/** Display order for doctor and list commands. */
export const DISPLAY_ORDER: readonly AgentName[] = [
    'claude',
    'codex',
    'gemini',
    'pi',
    'opencode',
    'antigravity',
    'openclaw',
];

/** Set of gateway/TUI-constrained agents. */
export const TIER2_AGENTS: ReadonlySet<AgentName> = new Set(['antigravity', 'openclaw']);

/** Return true when a value is a supported agent identifier. */
export function isAgentName(value: string): value is AgentName {
    return Object.hasOwn(AGENT_SHIMS, value);
}

/** Look up a bundled agent shim. */
export function getAgentShim(agent: AgentName): AgentShim {
    return AGENT_SHIMS[agent];
}
