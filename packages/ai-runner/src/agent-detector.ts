import { type AgentName, DISPLAY_ORDER, getAgentShim, resolveAgentName } from './agents/shims';
import { type AgentRunResult, AiRunner } from './ai-runner';

/** Installation/version probe result for one coding agent. */
export interface DetectedAgent {
    /** Canonical agent identifier (alias input is resolved to its canonical id). */
    name: AgentName | string;
    /** Whether the agent CLI was found and returned a parseable version. */
    installed: boolean;
    /** First version-output line when installed. */
    version: string | null;
    /** Agent-specific channels or models when available. */
    channels: string[];
    /** Detection error when unavailable. */
    error: string | null;
    /** True when the resolved canonical id is marked deprecated. */
    deprecated?: boolean;
    /** Canonical replacement when the resolved id is deprecated, if any. */
    replacedBy?: AgentName;
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
    /** Probe all bundled canonical agents in display order. */
    async detectAll(): Promise<DetectedAgent[]> {
        return await Promise.all(DISPLAY_ORDER.map((agent) => this.detectOne(agent)));
    }

    /** Probe one agent by canonical id or alias. */
    async detectOne(agent: string): Promise<DetectedAgent> {
        const canonical = resolveAgentName(agent);
        if (canonical === undefined) return unavailable(agent, `Unknown agent: ${agent}`);
        try {
            return this.parseResult(
                canonical,
                await this.runner.runVersionCommand(canonical, { timeout: this.timeout }),
            );
        } catch (error) {
            return unavailable(agent, error instanceof Error ? error.message : String(error));
        }
    }

    private parseResult(canonical: AgentName, result: AgentRunResult): DetectedAgent {
        const command = getAgentShim(canonical).command;
        const output = `${result.stdout}\n${result.stderr}`.trim();
        const lower = output.toLowerCase();
        if (lower.includes('command not found') || lower.includes('enoent') || lower.includes('not recognized')) {
            return unavailable(canonical, `${command}: command not found`);
        }
        if (result.signal !== undefined) {
            return unavailable(canonical, `Terminated by signal: ${result.signal}`);
        }
        if (result.exitCode === null) {
            return unavailable(canonical, 'Process did not produce an exit code');
        }
        if (result.exitCode !== 0) {
            return unavailable(
                canonical,
                `Non-zero exit code: ${result.exitCode}. stderr: ${result.stderr.slice(0, 200)}`,
            );
        }
        const match = VERSION_PATTERN.exec(output);
        if (match?.groups?.version === undefined) {
            return unavailable(canonical, 'Could not parse version output');
        }
        const version = output.split('\n')[0]?.trim() || match.groups.version;
        return {
            name: canonical,
            installed: true,
            version,
            channels: this.detectChannels(canonical, output),
            error: null,
            ...deprecationOf(canonical),
        };
    }

    private detectChannels(_agent: AgentName, _output: string): string[] {
        // Phase 2 hook: parse per-agent channel/model output here when shims expose it.
        return [];
    }
}
/** Build an "unavailable" detection result for an agent with the given error. */
function unavailable(name: AgentName | string, error: string): DetectedAgent {
    return { name, installed: false, version: null, channels: [], error, ...deprecationOf(name) };
}

/** Spread deprecation fields when the name resolves to a deprecated canonical id. */
function deprecationOf(name: AgentName | string): Partial<DetectedAgent> {
    const canonical = resolveAgentName(name);
    if (canonical === undefined) return {};
    const shim = getAgentShim(canonical);
    if (shim.deprecated === undefined) return {};
    return { deprecated: true, replacedBy: shim.deprecated.replacedBy };
}
