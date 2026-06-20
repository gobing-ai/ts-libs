import type { InboxMessageDao } from '@gobing-ai/ts-db/inbox';
import { EventBus } from '@gobing-ai/ts-infra';
import type { AgentSpec } from './agent-spec';
import { loadAgentSpecs } from './agent-spec';
import { type AgentName, resolveAgentName } from './agents/shims';
import { buildAgentCommand } from './ai-runner';
import type { AgentEvents } from './events';
import { formatMessage } from './messages';
import { TeamAgentProcess } from './team-agent-process';

type AgentProcessFactory = (options: ConstructorParameters<typeof TeamAgentProcess>[0]) => TeamAgentProcess;

/** Configuration options for `TeamOrchestrator`. */
export interface TeamOrchestratorOptions {
    processFactory?: AgentProcessFactory;
    events?: EventBus<AgentEvents>;
}

/**
 * Orchestrates a team of AI agents — loads specs, starts/stops agent processes, routes messages between them,
 * and emits lifecycle events. Agents in the same workspace see each other as peers.
 */
export class TeamOrchestrator {
    private specs: AgentSpec[] = [];
    private readonly running = new Map<string, TeamAgentProcess>();
    private readonly processFactory: AgentProcessFactory;
    private readonly events: EventBus<AgentEvents>;

    constructor(
        private readonly configDir: string,
        private readonly inbox: InboxMessageDao,
        options: TeamOrchestratorOptions = {},
    ) {
        this.processFactory = options.processFactory ?? ((processOptions) => new TeamAgentProcess(processOptions));
        this.events = options.events ?? new EventBus<AgentEvents>();
    }

    loadSpecs(): AgentSpec[] {
        this.specs = loadAgentSpecs(this.configDir);
        return [...this.specs];
    }

    getSpec(id: string): AgentSpec | undefined {
        if (this.specs.length === 0) this.loadSpecs();
        return this.specs.find((spec) => spec.id === id);
    }

    async startAgent(id: string): Promise<TeamAgentProcess> {
        const spec = this.requireSpec(id);
        const agentType = this.requireAgentName(spec.type);
        const peers = this.getPeerSpecs(spec.workspace, spec.id).map((peer) => ({
            id: peer.id,
            type: peer.type,
            purpose: peer.purpose,
        }));
        const command = buildAgentCommand(
            agentType,
            {
                purpose: spec.purpose,
                systemPrompt: typeof spec.config.systemPrompt === 'string' ? spec.config.systemPrompt : undefined,
                peers,
            },
            { workspace: spec.workspace },
        );
        const process = this.processFactory({
            spec,
            command: [command.command, ...command.args],
            cwd: spec.workspace,
        });
        await process.start();
        this.running.set(id, process);
        await this.injectPendingMessages(process);
        void this.events.emit('agent.started', {
            agentId: spec.id,
            agentType: spec.type,
            pid: process.getPid(),
        });
        return process;
    }

    async stopAgent(id: string): Promise<void> {
        const process = this.running.get(id);
        if (process === undefined) return;
        await process.stop();
        this.running.delete(id);
        void this.events.emit('agent.stopped', { agentId: id, exitCode: process.getExitCode() });
    }

    async restartAgent(id: string): Promise<TeamAgentProcess> {
        await this.stopAgent(id);
        return this.startAgent(id);
    }

    async sendMessage(fromId: string | null, toId: string, body: string, inReplyTo?: string): Promise<string> {
        const msgId = await this.inbox.enqueue(fromId, toId, body, inReplyTo);
        const process = this.running.get(toId);
        const ok = process !== undefined ? await this.flushInbox(process, 'live stdin injection failed') : false;
        void this.events.emit('agent.message.sent', { agentId: toId, ok });
        return msgId;
    }

    getRunningAgents(): Map<string, TeamAgentProcess> {
        return new Map(this.running);
    }

    getAgentStatus(id: string): 'running' | 'stopped' | 'errored' | 'unknown' {
        const process = this.running.get(id);
        if (process === undefined) return this.getSpec(id) === undefined ? 'unknown' : 'stopped';
        return process.getStatus();
    }

    getPeerSpecs(workspace: string, excludeId?: string): AgentSpec[] {
        if (this.specs.length === 0) this.loadSpecs();
        return this.specs.filter((spec) => spec.workspace === workspace && spec.id !== excludeId);
    }

    async stopAll(): Promise<void> {
        await Promise.all([...this.running.keys()].map((id) => this.stopAgent(id)));
    }

    on<K extends keyof AgentEvents>(event: K, listener: AgentEvents[K]): () => void {
        this.events.on(event, listener);
        return () => this.events.off(event, listener);
    }

    private requireSpec(id: string): AgentSpec {
        const spec = this.getSpec(id);
        if (spec === undefined) throw new Error(`Agent spec not found: ${id}`);
        return spec;
    }

    private requireAgentName(type: string): AgentName {
        const canonical = resolveAgentName(type);
        if (canonical === undefined) throw new Error(`Unsupported agent type: ${type}`);
        return canonical;
    }

    private async injectPendingMessages(process: TeamAgentProcess): Promise<boolean> {
        return this.flushInbox(process, 'startup stdin injection failed');
    }

    private async flushInbox(process: TeamAgentProcess, failLabel: string): Promise<boolean> {
        const messages = await this.inbox.drainPending(process.agentId);
        let ok = true;
        for (const message of messages) {
            const result = await process.send(formatMessage(message));
            if (result.ok) await this.inbox.markDelivered(message.id);
            else {
                ok = false;
                await this.inbox.markFailed(message.id, failLabel);
            }
        }
        return ok;
    }
}
