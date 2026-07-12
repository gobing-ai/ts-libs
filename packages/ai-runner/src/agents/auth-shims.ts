import { type FileSystem, getProcessEnv, joinPath } from '@gobing-ai/ts-runtime';
import type { AgentRunOptions, AgentRunResult, AiRunner } from '../ai-runner';
import { type AgentName, getAgentShim } from './shims';

/**
 * Authentication state for a coding agent — **tri-state by design**.
 *
 * `unknown` is first-class: several agents have no reliable auth probe
 * (no auth verb, no checkable credential file). Collapsing `unknown` to
 * `unauthenticated` is exactly the false-negative that used to make
 * `antigravity-cli` (no auth verb) and inconclusive probes report
 * `usable: false` despite being runnable.
 *
 * Auth detection is **off the execution critical path**: {@link isAuthenticated}
 * never feeds run-readiness — it is operator information only. A genuinely
 * unauthenticated agent fails at runtime with its own error (auth is the
 * agent's concern).
 */
export type AuthState = 'authenticated' | 'unauthenticated' | 'unknown';

/** Context injected into {@link isAuthenticated}. */
export interface AuthContext {
    /** Runner used to execute auth probes. */
    runner: AiRunner;
    /** Environment map for env/file auth checks. Defaults to the process env. */
    env?: Record<string, string | undefined>;
    /** Filesystem for auth-file checks. Required — inject a fake in tests. */
    fileSystem: FileSystem;
    /** Auth probe timeout in milliseconds. */
    timeout?: number;
}

const DEFAULT_AUTH_TIMEOUT_MS = 5_000;

/**
 * Per-agent auth-probe output patterns. A positive match ⇒ authenticated;
 * a negative match ⇒ unauthenticated; neither (or no probe) ⇒ unknown.
 */
const AUTH_PATTERNS: Partial<Record<AgentName, { positive: RegExp; negative: RegExp }>> = {
    claude: {
        positive: /authenticated|logged[\s_-]*in|"loggedIn"\s*:\s*true/i,
        negative:
            /not[\s_-]*authenticated|not[\s_-]*logged[\s_-]*in|logged[\s_-]*out|unauthenticated|"loggedIn"\s*:\s*false/i,
    },
    codex: {
        positive: /logged[\s_-]*in|authenticated/i,
        negative: /not[\s_-]*authenticated|not[\s_-]*logged[\s_-]*in|logged[\s_-]*out|unauthenticated/i,
    },
    opencode: {
        positive: /configured|available/i,
        negative: /not[\s_-]*configured|no[\s_-]+providers?[\s_-]+available|unavailable/i,
    },
    openclaw: {
        positive: /(^|[^a-z])ok([^a-z]|$)|healthy/i,
        negative: /not[\s_-]*healthy|unhealthy|not[\s_-]*ok/i,
    },
    pi: {
        positive: /\S/,
        negative: /not[\s_-]*authenticated|not[\s_-]*logged[\s_-]*in|unauthenticated|no[\s_-]+providers?/i,
    },
    omp: {
        positive: /\S/,
        negative: /not[\s_-]*authenticated|not[\s_-]*logged[\s_-]*in|unauthenticated|no[\s_-]+providers?/i,
    },
    hermes: {
        positive: /(^|[^a-z])ok([^a-z]|$)|healthy|configured|ready/i,
        negative: /not[\s_-]*(configured|healthy|ok)|unhealthy|missing[\s_-]+dependenc|error|failed/i,
    },
};

/** True when a value is a defined, non-blank string. */
function isNonEmpty(value: string | undefined): boolean {
    return value !== undefined && value.trim().length > 0;
}

/**
 * Resolve a coding agent's authentication state.
 *
 * **Never throws.** Any probe failure, inconclusive output, or missing probe
 * resolves to `unknown` rather than `unauthenticated` — see {@link AuthState}.
 *
 * Auth sources, in priority order per agent:
 * - **gemini** — credential-like content in `~/.gemini/settings.json`.
 * - **codex** — `codex login status` CLI output, falling back to an
 *   `~/.codex/auth{.json,}` credential file.
 * - **grok** — non-empty `XAI_API_KEY` env, else non-empty `~/.grok/auth.json`;
 *   no CLI auth-status verb (shim `getAuthCommand` is null).
 * - **pi / omp** — a non-empty `GOOGLE_API_KEY` or `ANTHROPIC_API_KEY` in env
 *   (an empty export is not a usable credential), else the CLI auth probe.
 * - **others** — the shim's auth command; matched against {@link AUTH_PATTERNS}.
 * - **no probe** (e.g. `antigravity-cli`) ⇒ `unknown`.
 */
export async function isAuthenticated(agent: AgentName, ctx: AuthContext): Promise<AuthState> {
    const env = ctx.env ?? getProcessEnv();
    const fs = ctx.fileSystem;
    const timeout = ctx.timeout ?? DEFAULT_AUTH_TIMEOUT_MS;
    const home = env.HOME || env.USERPROFILE || '';

    if (agent === 'gemini') return geminiSettingsContainCredentials(fs, home);
    if (agent === 'codex') return checkCodexAuth(ctx.runner, fs, home, timeout);
    if (agent === 'grok') return checkGrokAuth(fs, home, env);

    // pi and omp read provider keys from the environment; require a non-empty
    // value rather than mere presence (an empty export is not a usable credential).
    if ((agent === 'pi' || agent === 'omp') && (isNonEmpty(env.GOOGLE_API_KEY) || isNonEmpty(env.ANTHROPIC_API_KEY))) {
        return 'authenticated';
    }

    return probeAuthOutput(ctx.runner, agent, timeout);
}

async function checkCodexAuth(runner: AiRunner, fs: FileSystem, home: string, timeout: number): Promise<AuthState> {
    const probeStatus = await probeAuthOutput(runner, 'codex', timeout);
    if (probeStatus !== 'unknown') return probeStatus;
    const hasFile =
        (await hasNonEmptyFile(fs, joinPath(home, '.codex', 'auth.json'))) ||
        (await hasNonEmptyFile(fs, joinPath(home, '.codex', 'auth')));
    return hasFile ? 'authenticated' : 'unknown';
}

/**
 * Grok has no auth-status CLI verb. Credential sources (never false-negative
 * to `unauthenticated` when missing):
 * 1. non-empty `XAI_API_KEY`
 * 2. non-empty `~/.grok/auth.json`
 * Else `unknown`.
 */
async function checkGrokAuth(
    fs: FileSystem,
    home: string,
    env: Record<string, string | undefined>,
): Promise<AuthState> {
    if (isNonEmpty(env.XAI_API_KEY)) return 'authenticated';
    if (await hasNonEmptyFile(fs, joinPath(home, '.grok', 'auth.json'))) return 'authenticated';
    return 'unknown';
}

async function geminiSettingsContainCredentials(fs: FileSystem, home: string): Promise<AuthState> {
    try {
        const content = await fs.readFile(joinPath(home, '.gemini', 'settings.json'));
        return /auth|token|key/i.test(content) ? 'authenticated' : 'unauthenticated';
    } catch {
        // Missing or unreadable settings — auth state genuinely unknown.
        return 'unknown';
    }
}

async function probeAuthOutput(runner: AiRunner, agent: AgentName, timeout: number): Promise<AuthState> {
    const options: AgentRunOptions = { timeout };
    const command: Promise<AgentRunResult> | null = runner.runAuthCommand(agent, options);
    const patterns = AUTH_PATTERNS[agent];
    if (command === null || patterns === undefined) return 'unknown';
    try {
        const result = await command;
        if (result.exitCode !== 0) return 'unauthenticated';
        const output = `${result.stdout}\n${result.stderr}`;
        if (patterns.negative.test(output)) return 'unauthenticated';
        if (patterns.positive.test(output)) return 'authenticated';
        return 'unknown';
    } catch {
        return 'unknown';
    }
}

/** True when the path exists and has a non-zero size. */
async function hasNonEmptyFile(fs: FileSystem, path: string): Promise<boolean> {
    const stat = await fs.stat(path);
    if (stat === null) return false;
    return stat.isFile() && stat.size > 0;
}

// Re-exported so callers that only need the auth facet don't import getAgentShim directly.
export { getAgentShim };
