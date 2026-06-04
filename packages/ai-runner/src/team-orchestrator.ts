import type { AgentSpec } from './agent-spec';
import { loadAgentSpecs } from './agent-spec';
import { type AgentName, getAgentShim, isAgentName } from './agents/shims';
import { buildIdentityPreamble } from './identity';
import { MessageService } from './message-service';
import { TeamAgentProcess } from './team-agent-process';

type TeamEvent = 'agent.started' | 'agent.stopped' | 'message.sent';
type TeamListener = (payload: unknown) => void;
type AgentProcessFactory = (options: ConstructorParameters<typeof TeamAgentProcess>[0]) => TeamAgentProcess;

/** Configuration options for `TeamOrchestrator`. */
export interface TeamOrchestratorOptions {
    processFactory?: AgentProcessFactory;
}

/**
 * Orchestrates a team of AI agents — loads specs, starts/stops agent processes, routes messages between them,
 * and emits lifecycle events. Agents in the same workspace see each other as peers.
 */
export class TeamOrchestrator {
    private specs: AgentSpec[] = [];
    private readonly running = new Map<string, TeamAgentProcess>();
    private readonly listeners = new Map<TeamEvent, Set<TeamListener>>();
    private readonly processFactory: AgentProcessFactory;

    constructor(
        private readonly configDir: string,
        private readonly messageService: MessageService,
        options: TeamOrchestratorOptions = {},
    ) {
        this.processFactory = options.processFactory ?? ((processOptions) => new TeamAgentProcess(processOptions));
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
        const identityPreamble = buildIdentityPreamble({
            agentId: spec.id,
            agentType: spec.type,
            workspace: spec.workspace,
            purpose: spec.purpose,
            systemPrompt: typeof spec.config.systemPrompt === 'string' ? spec.config.systemPrompt : undefined,
            peers,
        });
        const command = getAgentShim(agentType).getPromptCommand({
            input: identityPreamble,
            purpose: spec.purpose,
            systemPrompt: typeof spec.config.systemPrompt === 'string' ? spec.config.systemPrompt : undefined,
            peers,
        });
        const process = this.processFactory({
            spec,
            command: [command.command, ...command.args],
            cwd: spec.workspace,
        });
        await process.start();
        this.running.set(id, process);
        await this.injectPendingMessages(process);
        this.emit('agent.started', { id });
        return process;
    }

    async stopAgent(id: string): Promise<void> {
        const process = this.running.get(id);
        if (process === undefined) return;
        await process.stop();
        this.running.delete(id);
        this.emit('agent.stopped', { id });
    }

    async restartAgent(id: string): Promise<TeamAgentProcess> {
        await this.stopAgent(id);
        return this.startAgent(id);
    }

    async sendMessage(fromId: string | null, toId: string, body: string, inReplyTo?: string): Promise<string> {
        const msgId = await this.messageService.enqueue(fromId, toId, body, inReplyTo);
        const process = this.running.get(toId);
        if (process !== undefined) await this.flushInbox(process, 'live stdin injection failed');
        this.emit('message.sent', { id: msgId, fromId, toId });
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

    on(event: TeamEvent, listener: TeamListener): () => void {
        const listeners = this.listeners.get(event) ?? new Set<TeamListener>();
        listeners.add(listener);
        this.listeners.set(event, listeners);
        return () => listeners.delete(listener);
    }

    private requireSpec(id: string): AgentSpec {
        const spec = this.getSpec(id);
        if (spec === undefined) throw new Error(`Agent spec not found: ${id}`);
        return spec;
    }

    private requireAgentName(type: string): AgentName {
        if (!isAgentName(type)) throw new Error(`Unsupported agent type: ${type}`);
        return type;
    }

    private injectPendingMessages(process: TeamAgentProcess): Promise<void> {
        return this.flushInbox(process, 'startup stdin injection failed');
    }

    private async flushInbox(process: TeamAgentProcess, failLabel: string): Promise<void> {
        const messages = await this.messageService.drain(process.agentId);
        for (const message of messages) {
            const result = await process.send(MessageService.formatMessage(message));
            if (result.ok) await this.messageService.deliver(message.id);
            else await this.messageService.fail(message.id, failLabel);
        }
    }

    private emit(event: TeamEvent, payload: unknown): void {
        for (const listener of this.listeners.get(event) ?? []) listener(payload);
    }
}
