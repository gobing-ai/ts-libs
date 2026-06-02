import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    type AgentProcessOptions,
    type AgentSpec,
    MessageService,
    saveAgentSpec,
    TeamAgentProcess,
    TeamOrchestrator,
} from '../src';

class MemoryDao {
    private readonly messages: Array<{
        id: string;
        fromId: string | null;
        toId: string;
        body: string;
        status: string;
        inReplyTo: string | null;
        createdAt: number;
        updatedAt: number;
        deliveredAt: number | null;
        injectAttempts: number;
        injectError: string | null;
    }> = [];

    async enqueue(fromId: string | null, toId: string, body: string, inReplyTo?: string): Promise<string> {
        const id = `msg-${this.messages.length + 1}`;
        this.messages.push({
            id,
            fromId,
            toId,
            body,
            status: 'queued',
            inReplyTo: inReplyTo ?? null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            deliveredAt: null,
            injectAttempts: 0,
            injectError: null,
        });
        return id;
    }

    async drainPending(toId: string) {
        const drained = this.messages.filter((message) => message.toId === toId && message.status === 'queued');
        for (const message of drained) {
            message.status = 'injected';
            message.injectAttempts += 1;
        }
        return drained;
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
        const service = new MessageService(dao as never);
        await service.enqueue(null, 'coder', 'queued before start');

        const created: FakeTeamAgentProcess[] = [];
        const orchestrator = new TeamOrchestrator(dir, service, {
            processFactory: (options) => {
                const teamProcess = new FakeTeamAgentProcess(options);
                created.push(teamProcess);
                return teamProcess;
            },
        });

        const startedEvents: unknown[] = [];
        orchestrator.on('agent.started', (event) => startedEvents.push(event));
        const teamProcess = await orchestrator.startAgent('coder');
        expect(teamProcess.getStatus()).toBe('running');
        expect(startedEvents).toEqual([{ id: 'coder' }]);
        expect(created[0]?.sent[0]).toContain('queued before start');
        expect(await service.countPending('coder')).toBe(0);

        const liveId = await orchestrator.sendMessage('planner', 'coder', 'live hello');
        expect(liveId).toBe('msg-2');
        expect(created[0]?.sent[1]).toContain('live hello');
        const createdProcess = created[0];
        if (createdProcess === undefined) throw new Error('Expected created process');
        createdProcess.sendSucceeds = false;
        await orchestrator.sendMessage('planner', 'coder', 'live fail');
        expect((await service.inbox('coder')).at(-1)).toMatchObject({ status: 'failed' });
        expect(orchestrator.getRunningAgents().has('coder')).toBeTrue();
        expect(orchestrator.getAgentStatus('coder')).toBe('running');
        expect(orchestrator.getPeerSpecs(workspace, 'coder').map((spec) => spec.id)).toEqual(['planner']);

        const stoppedEvents: unknown[] = [];
        orchestrator.on('agent.stopped', (event) => stoppedEvents.push(event));
        await orchestrator.restartAgent('coder');
        await orchestrator.stopAgent('missing');
        await orchestrator.stopAll();
        expect(orchestrator.getAgentStatus('coder')).toBe('stopped');
        expect(stoppedEvents).toContainEqual({ id: 'coder' });
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
