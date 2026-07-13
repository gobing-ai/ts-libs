import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '@gobing-ai/ts-infra';
import {
    type AgentEvents,
    type AgentProcessOptions,
    type AgentSpec,
    type DrainedMessage,
    type MessageStore,
    saveAgentSpec,
    TeamAgentProcess,
    TeamOrchestrator,
} from '../src';

class MemoryDao implements MessageStore {
    private readonly messages: Array<{
        id: string;
        fromId: string | null;
        toId: string;
        body: string;
        status: string;
        deliveredAt: number | null;
        injectError: string | null;
    }> = [];

    async enqueue(fromId: string | null, toId: string, body: string, _inReplyTo?: string): Promise<string> {
        const id = `msg-${this.messages.length + 1}`;
        this.messages.push({
            id,
            fromId,
            toId,
            body,
            status: 'queued',
            deliveredAt: null,
            injectError: null,
        });
        return id;
    }

    async drainPending(toId: string): Promise<DrainedMessage[]> {
        const drained = this.messages.filter((message) => message.toId === toId && message.status === 'queued');
        for (const message of drained) {
            message.status = 'injected';
        }
        return drained.map(({ id, fromId, body }) => ({ id, fromId, body }));
    }

    async markDelivered(msgId: string): Promise<void> {
        const message = this.messages.find((entry) => entry.id === msgId);
        if (message !== undefined) {
            message.status = 'delivered';
            message.deliveredAt = Date.now();
        }
    }

    async markFailed(msgId: string, error: string): Promise<void> {
        const message = this.messages.find((entry) => entry.id === msgId);
        if (message !== undefined) {
            message.status = 'failed';
            message.injectError = error;
        }
    }

    async inbox(toId: string) {
        return this.messages.filter((message) => message.toId === toId);
    }

    async countPending(toId: string): Promise<number> {
        return this.messages.filter((message) => message.toId === toId && message.status === 'queued').length;
    }
}

class FakeTeamAgentProcess extends TeamAgentProcess {
    readonly sent: string[] = [];
    sendSucceeds = true;
    private fakeStatus: 'running' | 'stopped' | 'errored' = 'stopped';

    constructor(options: AgentProcessOptions) {
        super(options);
    }

    override async start(): Promise<void> {
        this.fakeStatus = 'running';
    }

    override async stop(): Promise<void> {
        this.fakeStatus = 'stopped';
    }

    override async send(message: string): Promise<{ ok: boolean }> {
        this.sent.push(message);
        return { ok: this.sendSucceeds };
    }

    override getStatus(): 'running' | 'stopped' | 'errored' {
        return this.fakeStatus;
    }
}

describe('TeamOrchestrator', () => {
    test('starts agents, drains pending messages, injects live messages, and stops all', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'team-orchestrator-'));
        const workspace = process.cwd();
        await writeSpec(dir, { id: 'coder', type: 'codex', workspace, purpose: 'Implement' });
        await writeSpec(dir, { id: 'planner', type: 'claude', workspace, purpose: 'Plan' });

        const dao = new MemoryDao();
        await dao.enqueue(null, 'coder', 'queued before start');
        const events = new EventBus<AgentEvents>();
        const busEvents: string[] = [];
        events.on('agent.started', (event) => busEvents.push(`started:${event.agentId}:${event.agentType}`));
        events.on('agent.stopped', (event) => busEvents.push(`stopped:${event.agentId}:${event.exitCode}`));
        events.on('agent.message.sent', (event) => busEvents.push(`message:${event.agentId}:${event.ok}`));

        const created: FakeTeamAgentProcess[] = [];
        const orchestrator = new TeamOrchestrator(dir, dao, {
            events,
            processFactory: (options) => {
                const teamProcess = new FakeTeamAgentProcess(options);
                created.push(teamProcess);
                return teamProcess;
            },
        });

        const startedEvents: Array<Parameters<AgentEvents['agent.started']>[0]> = [];
        orchestrator.on('agent.started', (event) => startedEvents.push(event));
        const teamProcess = await orchestrator.startAgent('coder');
        expect(teamProcess.getStatus()).toBe('running');
        expect(startedEvents).toEqual([{ agentId: 'coder', agentType: 'codex', pid: null }]);
        expect(created[0]?.sent[0]).toContain('queued before start');
        expect(await dao.countPending('coder')).toBe(0);

        const liveId = await orchestrator.sendMessage('planner', 'coder', 'live hello');
        expect(liveId).toBe('msg-2');
        expect(created[0]?.sent[1]).toContain('live hello');
        const createdProcess = created[0];
        if (createdProcess === undefined) throw new Error('Expected created process');
        createdProcess.sendSucceeds = false;
        await orchestrator.sendMessage('planner', 'coder', 'live fail');
        expect((await dao.inbox('coder')).at(-1)).toMatchObject({ status: 'failed' });
        await orchestrator.sendMessage('planner', 'missing', 'queued for stopped agent');
        expect(orchestrator.getRunningAgents().has('coder')).toBeTrue();
        expect(await orchestrator.getAgentStatus('coder')).toBe('running');
        expect((await orchestrator.getPeerSpecs(workspace, 'coder')).map((spec) => spec.id)).toEqual(['planner']);

        const stoppedEvents: Array<Parameters<AgentEvents['agent.stopped']>[0]> = [];
        orchestrator.on('agent.stopped', (event) => stoppedEvents.push(event));
        await orchestrator.restartAgent('coder');
        await orchestrator.stopAgent('missing');
        await orchestrator.stopAll();
        expect(await orchestrator.getAgentStatus('coder')).toBe('stopped');
        expect(stoppedEvents).toContainEqual({ agentId: 'coder', exitCode: null });
        expect(busEvents).toContain('started:coder:codex');
        expect(busEvents).toContain('stopped:coder:null');
        expect(busEvents).toContain('message:coder:true');
        expect(busEvents).toContain('message:coder:false');
        expect(busEvents).toContain('message:missing:false');
    });

    test('omitting events leaves orchestration behavior unchanged', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'team-orchestrator-no-events-'));
        await writeSpec(dir, { id: 'coder', type: 'codex', workspace: process.cwd(), purpose: 'Implement' });
        const created: FakeTeamAgentProcess[] = [];
        const orchestrator = new TeamOrchestrator(dir, new MemoryDao(), {
            processFactory: (options) => {
                const teamProcess = new FakeTeamAgentProcess(options);
                created.push(teamProcess);
                return teamProcess;
            },
        });

        await orchestrator.startAgent('coder');
        await orchestrator.sendMessage(null, 'coder', 'hello');
        await orchestrator.stopAll();

        expect(created[0]?.sent[0]).toContain('hello');
        expect(await orchestrator.getAgentStatus('coder')).toBe('stopped');
    });
});

async function writeSpec(dir: string, patch: Pick<AgentSpec, 'id' | 'type' | 'workspace' | 'purpose'>): Promise<void> {
    await saveAgentSpec(
        {
            ...patch,
            name: patch.id,
            tags: [],
            config: {},
        },
        dir,
    );
}
