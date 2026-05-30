import { homedir } from 'node:os';
import { join } from 'node:path';
import { NodeFileSystem } from '@gobing-ai/ts-runtime';
import { AgentDetector, type DetectedAgent } from './agent-detector';
import { type AgentName, isAgentName, TIER2_AGENTS } from './agents/shims';
import { AiRunner } from './ai-runner';

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
}

const DEFAULT_TIMEOUT_MS = 5_000;

/** Runs installation and auth health checks for supported coding agents. */
export class DoctorRunner {
    private readonly detector: AgentDetector;
    private readonly runner: AiRunner;
    private readonly timeout: number;
    private readonly env: Record<string, string | undefined>;
    private readonly fs = new NodeFileSystem();

    constructor(options: DoctorRunnerOptions = {}) {
        this.runner = options.runner ?? new AiRunner();
        this.detector = options.agentDetector ?? new AgentDetector({ runner: this.runner });
        this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
        this.env = options.env ?? process.env;
    }

    /** Run a health check on all supported agents. */
    async runAll(): Promise<DoctorResult[]> {
        const detected = await this.detector.detectAll();
        return await Promise.all(detected.map((agent) => this.buildResult(agent)));
    }

    /** Run a health check on one agent. */
    async runOne(agent: string): Promise<DoctorResult> {
        return this.buildResult(await this.detector.detectOne(agent));
    }

    private async buildResult(detected: DetectedAgent): Promise<DoctorResult> {
        const tier = TIER2_AGENTS.has(detected.name as AgentName) ? 2 : 1;
        const authenticated =
            detected.installed && isAgentName(detected.name) ? await this.checkAuth(detected.name) : false;
        return {
            agent: detected.name,
            installed: detected.installed,
            version: detected.version,
            authenticated,
            usable: detected.installed && detected.version !== null && authenticated,
            tier,
            channels: detected.channels,
            error: detected.error,
        };
    }

    private async checkAuth(agent: AgentName): Promise<boolean> {
        if (agent === 'gemini') return this.fs.exists(join(homedir(), '.gemini', 'settings.json'));
        if (agent === 'codex' && (await this.fs.exists(join(homedir(), '.codex', 'auth.json')))) return true;
        if (agent === 'pi' && (this.env.GOOGLE_API_KEY !== undefined || this.env.ANTHROPIC_API_KEY !== undefined))
            return true;
        const command = this.runner.runAuthCommand(agent, { timeout: this.timeout });
        if (command === null) return false;
        const result = await command;
        return (
            result.exitCode === 0 &&
            !/not authenticated|not logged|unauthenticated/i.test(`${result.stdout}\n${result.stderr}`)
        );
    }
}
