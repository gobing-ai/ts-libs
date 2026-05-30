import { type AgentName, DISPLAY_ORDER, getAgentShim, isAgentName } from './agents/shims';
import { type AgentRunResult, AiRunner } from './ai-runner';

/** Installation/version probe result for one coding agent. */
export interface DetectedAgent {
    /** Agent identifier. */
    name: AgentName | string;
    /** Whether the agent CLI was found and returned a parseable version. */
    installed: boolean;
    /** First version-output line when installed. */
    version: string | null;
    /** Agent-specific channels or models when available. */
    channels: string[];
    /** Detection error when unavailable. */
    error: string | null;
}

/** Constructor options for AgentDetector. */
export interface AgentDetectorOptions {
    /** Shared AiRunner instance. */
    runner?: AiRunner;
    /** Per-agent version probe timeout in milliseconds. */
    timeout?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const VERSION_PATTERN = /(?<version>\d+\.\d+(?:\.\d+)?)/;

/** Probes supported coding-agent CLIs for installation and version state. */
export class AgentDetector {
    private readonly runner: AiRunner;
    private readonly timeout: number;

    constructor(options: AgentDetectorOptions = {}) {
        this.runner = options.runner ?? new AiRunner();
        this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    }

    /** Probe all bundled agents in display order. */
    async detectAll(): Promise<DetectedAgent[]> {
        return await Promise.all(DISPLAY_ORDER.map((agent) => this.detectOne(agent)));
    }

    /** Probe one agent by name. */
    async detectOne(agent: string): Promise<DetectedAgent> {
        if (!isAgentName(agent)) {
            return { name: agent, installed: false, version: null, channels: [], error: `Unknown agent: ${agent}` };
        }
        try {
            return this.parseResult(agent, await this.runner.runVersionCommand(agent, { timeout: this.timeout }));
        } catch (error) {
            return {
                name: agent,
                installed: false,
                version: null,
                channels: [],
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    private parseResult(agent: AgentName, result: AgentRunResult): DetectedAgent {
        const command = getAgentShim(agent).command;
        const output = `${result.stdout}\n${result.stderr}`.trim();
        const lower = output.toLowerCase();
        if (lower.includes('command not found') || lower.includes('enoent') || lower.includes('not recognized')) {
            return {
                name: agent,
                installed: false,
                version: null,
                channels: [],
                error: `${command}: command not found`,
            };
        }
        if (result.signal !== undefined || result.exitCode === null) {
            return {
                name: agent,
                installed: false,
                version: null,
                channels: [],
                error: result.signal ?? 'Process timed out',
            };
        }
        if (result.exitCode !== 0) {
            return {
                name: agent,
                installed: false,
                version: null,
                channels: [],
                error: `Non-zero exit code ${result.exitCode}: ${result.stderr.slice(0, 200)}`,
            };
        }
        const match = VERSION_PATTERN.exec(output);
        if (match?.groups?.version === undefined) {
            return {
                name: agent,
                installed: false,
                version: null,
                channels: [],
                error: 'Could not parse version output',
            };
        }
        return {
            name: agent,
            installed: true,
            version: output.split('\n')[0] ?? match.groups.version,
            channels: [],
            error: null,
        };
    }
}
