import { getLogger, type Logger } from '@gobing-ai/ts-infra';
import { createNodeFileSystem, type FileSystem, getProcessEnv } from '@gobing-ai/ts-runtime';
import { AgentDetector, type DetectedAgent } from './agent-detector';
import { type AuthState, isAuthenticated } from './agents/auth-shims';
import { DISPLAY_ORDER, resolveAgentName, TIER2_AGENTS } from './agents/shims';
import { AiRunner } from './ai-runner';
import {
    DEFAULT_PROBE_TIMEOUT_MS,
    extractProvider,
    ModelHealthProbeRegistry,
    type ModelHealthResult,
    OmpModelProbe,
} from './model-health-probe';

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
    replacedBy?: string;
    /** Model health status when a probe was run; `null` when no model override applies. */
    modelStatus?: ModelHealthResult | null;
    /** Probe error when unavailable. */
    error: string | null;
}

/** Executor configuration — mirrors Spur's AgentExecutorConfig for doctor probing. */
export interface ExecutorConfig {
    /** Executor name (e.g. `omp-zai`, `omp-zai-volc`). */
    name: string;
    /** Underlying agent binary (e.g. `omp`). */
    agent: string;
    /** Model string in `provider/model` form (e.g. `zai/glm-5.2`). */
    model?: string;
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
    /** Executor configurations — when present, doctor probes each executor's model health. */
    executors?: ExecutorConfig[];
    /** Probe registry for model health checks. Defaults to a registry with {@link OmpModelProbe}. */
    probeRegistry?: ModelHealthProbeRegistry;
    /** Model health probe timeout in milliseconds (default 10s). */
    probeTimeoutMs?: number;
    /**
     * Probe authentication during health checks. Default `true` (existing behavior).
     * When `false`, results report `authenticated: 'unknown'` — the probe is skipped
     * entirely: no auth subprocess and no credential-file read.
     */
    probeAuth?: boolean;
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
    private readonly executors: ExecutorConfig[];
    private readonly probeRegistry: ModelHealthProbeRegistry;
    private readonly probeTimeoutMs: number;
    private readonly probeAuth: boolean;

    constructor(options: DoctorRunnerOptions = {}) {
        this.runner = options.runner ?? new AiRunner();
        this.detector = options.agentDetector ?? new AgentDetector({ runner: this.runner });
        this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
        this.env = options.env ?? getProcessEnv();
        this.fs = options.fileSystem ?? createNodeFileSystem();
        this.logger = options.logger ?? getLogger('doctor');
        this.executors = options.executors ?? [];
        this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
        this.probeRegistry = options.probeRegistry ?? this.createDefaultRegistry();
        this.probeAuth = options.probeAuth ?? true;
    }

    /** Create the default probe registry with OmpModelProbe for all known omp providers. */
    private createDefaultRegistry(): ModelHealthProbeRegistry {
        const registry = new ModelHealthProbeRegistry();
        const probe = new OmpModelProbe();
        for (const provider of ['zai', 'volc', 'minimax', 'deepseek']) {
            registry.register(provider, probe);
        }
        return registry;
    }

    /** Run a health check on all supported agents. */
    async runAll(): Promise<DoctorResult[]> {
        if (this.executors.length > 0) {
            return await this.runAllWithExecutors();
        }
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

    /**
     * Executor-aware runAll: iterate configured executors instead of
     * DISPLAY_ORDER, giving each executor its own row with model health.
     */
    private async runAllWithExecutors(): Promise<DoctorResult[]> {
        const detected = await this.detector.detectAll();
        const byName = new Map(detected.map((agent) => [agent.name, agent]));
        const results: DoctorResult[] = [];
        for (const executor of this.executors) {
            // Resolve aliases/binary names to the canonical id so an executor
            // configured with `agent: agy` matches the detected `antigravity-cli`
            // row instead of falling through to "Unknown agent" (task 0038 R4).
            const canonical = resolveAgentName(executor.agent);
            const agentDetected = byName.get(executor.agent) ??
                (canonical !== undefined ? byName.get(canonical) : undefined) ?? {
                    name: executor.agent,
                    installed: false,
                    version: null,
                    channels: [],
                    error: `Unknown agent: ${executor.agent}`,
                };
            const result = await this.buildResult(agentDetected);
            // Override the agent name with the executor name for display
            result.agent = executor.name;
            // R1: probe model health when a model override is present; null otherwise.
            result.modelStatus = executor.model ? await this.probeModel(executor.model) : null;
            results.push(result);
        }
        return results;
    }

    /** Run a health check on one agent. */
    async runOne(agent: string): Promise<DoctorResult> {
        // When executors are configured, match executor name first
        if (this.executors.length > 0) {
            const executor = this.executors.find((e) => e.name === agent);
            if (executor) {
                const detected = await this.detector.detectOne(executor.agent);
                const result = await this.buildResult(detected);
                result.agent = executor.name;
                result.modelStatus = executor.model ? await this.probeModel(executor.model) : null;
                return result;
            }
        }
        return this.buildResult(await this.detector.detectOne(agent));
    }

    /** Probe model health for a `provider/model` string. */
    private async probeModel(model: string): Promise<ModelHealthResult> {
        const provider = extractProvider(model);
        const probe = this.probeRegistry.resolve(model);
        if (!probe) {
            return {
                status: 'unknown',
                detail: `no probe registered for provider '${provider}'`,
                checkedAt: new Date().toISOString(),
            };
        }
        const apiKey = this.resolveApiKey(provider);
        if (!apiKey) {
            return {
                status: 'unknown',
                detail: `API key not found for provider '${provider}'`,
                checkedAt: new Date().toISOString(),
            };
        }
        return await probe.probe(provider, model, {
            apiKey,
            timeoutMs: this.probeTimeoutMs,
        });
    }

    /** Resolve API key from env using `{PROVIDER_UPPERCASE}_API_KEY` convention. */
    private resolveApiKey(provider: string): string | undefined {
        return this.env[`${provider.toUpperCase()}_API_KEY`];
    }

    private async buildResult(detected: DetectedAgent): Promise<DoctorResult> {
        const canonical = resolveAgentName(detected.name) ?? null;
        const tier = canonical !== null && TIER2_AGENTS.has(canonical) ? 2 : 1;
        this.logger.debug('checking agent', { agent: detected.name, installed: detected.installed, tier });
        // 'unauthenticated' would be a claim; a suppressed probe claims nothing,
        // so the skip path reports 'unknown'.
        const authenticated: AuthState = !this.probeAuth
            ? 'unknown'
            : detected.installed && canonical !== null
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
            // Liveness only: auth never gates runnability. A logged-out
            // agent is usable (it fails at runtime with its own error).
            usable: detected.installed && detected.version !== null,
            tier,
            channels: detected.channels,
            deprecated: detected.deprecated,
            replacedBy: detected.replacedBy,
            error: detected.error,
        };
    }
}
