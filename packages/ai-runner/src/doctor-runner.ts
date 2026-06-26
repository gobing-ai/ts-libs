import { getLogger, type Logger } from '@gobing-ai/ts-infra';
import { createNodeFileSystem, type FileSystem, getProcessEnv } from '@gobing-ai/ts-runtime';
import { AgentDetector, type DetectedAgent } from './agent-detector';
import { type AuthState, isAuthenticated } from './agents/auth-shims';
import { type AgentName, DISPLAY_ORDER, resolveAgentName, TIER2_AGENTS } from './agents/shims';
import { AiRunner } from './ai-runner';

/** Health-check result for one coding agent. */
export interface DoctorResult {
    /** Agent identifier. */
    agent: string;
    /** Whether the CLI is installed. */
    installed: boolean;
    /** Human-readable version when installed. */
    version: string | null;
    /**
     * Authentication state — **tri-state** (`authenticated | unauthenticated |
     * unknown`). Informational only; never feeds {@link usable} or any
     * run-readiness gate. A genuinely unauthenticated agent fails at runtime
     * with its own error.
     */
    authenticated: AuthState;
    /**
     * Whether the agent is **runnable** — liveness only
     * (`installed && version !== null`). Auth is NOT consulted: a logged-out
     * agent is still `usable` (it will fail at runtime with its own auth error).
     */
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
    /** Filesystem for auth-file checks. Defaults to `createNodeFileSystem()`; inject to test without disk. */
    fileSystem?: FileSystem;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/** Runs installation, liveness, and auth health checks for supported coding agents. */
export class DoctorRunner {
    private readonly detector: AgentDetector;
    private readonly runner: AiRunner;
    private readonly timeout: number;
    private readonly env: Record<string, string | undefined>;
    private readonly fs: FileSystem;
    private readonly logger: Logger;

    constructor(options: DoctorRunnerOptions = {}) {
        this.runner = options.runner ?? new AiRunner();
        this.detector = options.agentDetector ?? new AgentDetector({ runner: this.runner });
        this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
        this.env = options.env ?? getProcessEnv();
        this.fs = options.fileSystem ?? createNodeFileSystem();
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
        const authenticated: AuthState =
            detected.installed && canonical !== null
                ? await isAuthenticated(canonical, {
                      runner: this.runner,
                      env: this.env,
                      fileSystem: this.fs,
                      timeout: this.timeout,
                  })
                : 'unauthenticated';
        return {
            agent: detected.name,
            installed: detected.installed,
            version: detected.version,
            authenticated,
            // Liveness only: auth never gates runnability. A logged-out agent
            // is usable (it fails at runtime with its own error).
            usable: detected.installed && detected.version !== null,
            tier,
            channels: detected.channels,
            deprecated: detected.deprecated,
            replacedBy: detected.replacedBy,
            error: detected.error,
        };
    }
}
