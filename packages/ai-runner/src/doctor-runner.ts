import { getLogger, type Logger } from '@gobing-ai/ts-infra';
import { getProcessEnv, joinPath, NodeFileSystem } from '@gobing-ai/ts-runtime';
import { AgentDetector, type DetectedAgent } from './agent-detector';
import { type AgentName, DISPLAY_ORDER, resolveAgentName, TIER2_AGENTS } from './agents/shims';
import { type AgentRunResult, AiRunner } from './ai-runner';

/** Health-check result for one coding agent. */
export interface DoctorResult {
    /** Agent identifier. */
    agent: string;
    /** Whether the CLI is installed. */
    installed: boolean;
    /** Human-readable version when installed. */
    version: string | null;
    /** Whether the agent appears authenticated. */
    authenticated: boolean;
    /** Whether the agent is ready for direct use. */
    usable: boolean;
    /** Capability tier: 1 = direct CLI, 2 = gateway/TUI constrained. */
    tier: 1 | 2;
    /** Agent-specific channels or models when available. */
    channels: string[];
    /** True when the resolved canonical id is marked deprecated. */
    deprecated?: boolean;
    /** Canonical replacement when the resolved id is deprecated, if any. */
    replacedBy?: AgentName;
    /** Probe error when unavailable. */
    error: string | null;
}

/** Constructor options for DoctorRunner. */
export interface DoctorRunnerOptions {
    /** Shared detector. */
    agentDetector?: AgentDetector;
    /** Shared runner. */
    runner?: AiRunner;
    /** Auth probe timeout in milliseconds. */
    timeout?: number;
    /** Environment map for file/env auth checks. */
    env?: Record<string, string | undefined>;
    /** Logger for health-check diagnostics. Defaults to `getLogger('doctor')`. */
    logger?: Logger;
}

const DEFAULT_TIMEOUT_MS = 5_000;
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

/** Runs installation and auth health checks for supported coding agents. */
export class DoctorRunner {
    private readonly detector: AgentDetector;
    private readonly runner: AiRunner;
    private readonly timeout: number;
    private readonly env: Record<string, string | undefined>;
    private readonly fs = new NodeFileSystem();
    private readonly logger: Logger;

    constructor(options: DoctorRunnerOptions = {}) {
        this.runner = options.runner ?? new AiRunner();
        this.detector = options.agentDetector ?? new AgentDetector({ runner: this.runner });
        this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
        this.env = options.env ?? getProcessEnv();
        this.logger = options.logger ?? getLogger('doctor');
    }

    /** Run a health check on all supported agents. */
    async runAll(): Promise<DoctorResult[]> {
        const detected = await this.detector.detectAll();
        const byName = new Map(detected.map((agent) => [agent.name, agent]));
        return await Promise.all(
            DISPLAY_ORDER.map((agent) =>
                this.buildResult(
                    byName.get(agent) ?? {
                        name: agent,
                        installed: false,
                        version: null,
                        channels: [],
                        error: `Unknown agent: ${agent}`,
                    },
                ),
            ),
        );
    }

    /** Run a health check on one agent. */
    async runOne(agent: string): Promise<DoctorResult> {
        return this.buildResult(await this.detector.detectOne(agent));
    }

    private async buildResult(detected: DetectedAgent): Promise<DoctorResult> {
        const canonical = resolveAgentName(detected.name) ?? null;
        const tier = canonical !== null && TIER2_AGENTS.has(canonical) ? 2 : 1;
        this.logger.debug('checking agent', { agent: detected.name, installed: detected.installed, tier });
        const authenticated = detected.installed && canonical !== null ? await this.checkAuth(canonical) : false;
        return {
            agent: detected.name,
            installed: detected.installed,
            version: detected.version,
            authenticated,
            usable: detected.installed && detected.version !== null && authenticated,
            tier,
            channels: detected.channels,
            deprecated: detected.deprecated,
            replacedBy: detected.replacedBy,
            error: detected.error,
        };
    }

    private async checkAuth(agent: AgentName): Promise<boolean> {
        const home = this.env.HOME || this.env.USERPROFILE || '';
        if (agent === 'gemini') return this.geminiSettingsContainCredentials(home);
        if (agent === 'codex') return this.checkCodexAuth(home);
        // pi and omp read provider keys from the environment; require a non-empty
        // value rather than mere presence (an empty export is not a usable credential).
        if (
            (agent === 'pi' || agent === 'omp') &&
            (isNonEmpty(this.env.GOOGLE_API_KEY) || isNonEmpty(this.env.ANTHROPIC_API_KEY))
        )
            return true;
        return (await this.probeAuthOutput(agent)) === true;
    }

    private async checkCodexAuth(home: string): Promise<boolean> {
        const probeStatus = await this.probeAuthOutput('codex');
        if (probeStatus !== null) return probeStatus;
        return (
            (await this.hasNonEmptyFile(joinPath(home, '.codex', 'auth.json'))) ||
            (await this.hasNonEmptyFile(joinPath(home, '.codex', 'auth')))
        );
    }

    private async geminiSettingsContainCredentials(home: string): Promise<boolean> {
        try {
            return /auth|token|key/i.test(await this.fs.readFile(joinPath(home, '.gemini', 'settings.json')));
        } catch {
            return false;
        }
    }

    private async probeAuthOutput(agent: AgentName): Promise<boolean | null> {
        const command = this.runner.runAuthCommand(agent, { timeout: this.timeout });
        const patterns = AUTH_PATTERNS[agent];
        if (command === null || patterns === undefined) return null;
        const result: AgentRunResult = await command;
        if (result.exitCode !== 0) return false;
        const output = `${result.stdout}\n${result.stderr}`;
        if (patterns.negative.test(output)) return false;
        if (patterns.positive.test(output)) return true;
        return null;
    }

    /** True when the path exists and has a non-zero size. */
    private async hasNonEmptyFile(path: string): Promise<boolean> {
        const stat = await this.fs.stat(path);
        if (stat === null) return false;
        return stat.isFile() && stat.size > 0;
    }
}
