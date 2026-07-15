import { describe, expect, test } from 'bun:test';
import { NodeProcessExecutor } from '../src/process-executor';
import {
    createInMemoryProcessRegistry,
    type ProcessExecution,
    type ProcessRegistryEvent,
} from '../src/process-registry';

describe('InMemoryProcessRegistry', () => {
    test('begin / complete tracks lifecycle and listExecutions order', () => {
        const registry = createInMemoryProcessRegistry();
        const id = registry.begin({
            command: 'echo',
            args: ['hi'],
            label: 'test.echo',
            source: 'one-shot',
            agentId: 'alpha-claude',
        });

        const running = registry.getExecution(id);
        expect(running?.status).toBe('running');
        expect(running).toMatchObject({
            command: 'echo',
            args: ['hi'],
            label: 'test.echo',
            source: 'one-shot',
            agentId: 'alpha-claude',
        });
        expect(registry.listExecutions({ running: true })).toHaveLength(1);

        registry.complete(id, { exitCode: 0, pid: 4242 });
        const done = registry.getExecution(id);
        expect(done?.status).toBe('exited');
        expect(done?.exitCode).toBe(0);
        expect(done?.pid).toBe(4242);
        expect(done?.exitedAt).toBeDefined();
        expect(registry.listExecutions({ running: true })).toHaveLength(0);
        expect(registry.listExecutions({ running: false })).toHaveLength(1);
    });

    test('subscribe receives started, updated, and exited events', () => {
        const registry = createInMemoryProcessRegistry();
        const events: ProcessRegistryEvent[] = [];
        const unsub = registry.subscribe((e) => events.push(e));

        const id = registry.begin({ command: 'sleep', args: ['1'], source: 'supervisor' });
        registry.update(id, { pid: 99 });
        registry.complete(id, { exitCode: 0 });

        expect(events.map((e) => e.type)).toEqual(['started', 'updated', 'exited']);
        expect(events[0]?.execution.id).toBe(id);
        expect(events[1]?.execution.pid).toBe(99);
        expect(events[2]?.execution.status).toBe('exited');

        unsub();
        registry.begin({ command: 'echo' });
        // No further events after unsubscribe.
        expect(events).toHaveLength(3);
    });

    test('filters by source / team / agent', () => {
        const registry = createInMemoryProcessRegistry();
        registry.begin({ command: 'a', source: 'supervisor', teamId: 't1', agentId: 'a1' });
        registry.begin({ command: 'b', source: 'one-shot', teamId: 't1', agentId: 'a2' });
        registry.begin({ command: 'c', source: 'other', teamId: 't2' });

        expect(registry.listExecutions({ source: 'supervisor' }).map((e) => e.command)).toEqual(['a']);
        expect(registry.listExecutions({ teamId: 't1' }).map((e) => e.command)).toEqual(['a', 'b']);
        expect(registry.listExecutions({ agentId: 'a2' }).map((e) => e.command)).toEqual(['b']);
    });

    test('enforces maxEntries by dropping oldest exited first', () => {
        const registry = createInMemoryProcessRegistry({ maxEntries: 2 });
        const id1 = registry.begin({ command: 'one' });
        registry.complete(id1, { exitCode: 0 });
        const id2 = registry.begin({ command: 'two' });
        // Still under cap while both present: 2.
        expect(registry.listExecutions()).toHaveLength(2);
        const id3 = registry.begin({ command: 'three' });
        // Cap 2: oldest exited (id1) dropped; id2 running + id3 remain.
        const listed = registry.listExecutions();
        expect(listed).toHaveLength(2);
        expect(listed.map((e) => e.id)).toEqual([id2, id3]);
        expect(registry.getExecution(id1)).toBeUndefined();
    });

    test('complete is idempotent; clear empties the registry', () => {
        const registry = createInMemoryProcessRegistry();
        const id = registry.begin({ command: 'echo' });
        registry.complete(id, { exitCode: 1 });
        registry.complete(id, { exitCode: 0 }); // ignored for exitCode once exited
        expect(registry.getExecution(id)?.exitCode).toBe(1);

        registry.clear();
        expect(registry.listExecutions()).toHaveLength(0);
    });

    test('listener errors do not break other listeners', () => {
        const registry = createInMemoryProcessRegistry();
        const seen: string[] = [];
        registry.subscribe(() => {
            throw new Error('boom');
        });
        registry.subscribe((e) => seen.push(e.type));
        registry.begin({ command: 'echo' });
        expect(seen).toEqual(['started']);
    });
});

describe('NodeProcessExecutor + ProcessRegistry integration', () => {
    test('run records one-shot execution with label/agent metadata', async () => {
        const registry = createInMemoryProcessRegistry();
        const exec = new NodeProcessExecutor({ registry });

        const result = await exec.run({
            command: 'echo',
            args: ['tracked'],
            label: 'test.echo',
            agentId: 'planner',
            teamId: 'alpha',
        });

        expect(result.exitCode).toBe(0);
        const listed = registry.listExecutions() as ProcessExecution[];
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({
            command: 'echo',
            args: ['tracked'],
            label: 'test.echo',
            source: 'one-shot',
            agentId: 'planner',
            teamId: 'alpha',
            status: 'exited',
            exitCode: 0,
        });
        expect(listed[0]?.startedAt).toBeDefined();
        expect(listed[0]?.exitedAt).toBeDefined();
    });

    test('runStreaming records supervisor-tagged process with pid and exit', async () => {
        const registry = createInMemoryProcessRegistry();
        const exec = new NodeProcessExecutor({ registry });

        const proc = exec.runStreaming({
            command: 'cat',
            source: 'supervisor',
            agentId: 'alpha-claude',
            label: 'agent:alpha-claude',
        });

        // While running, registry shows a running entry with pid.
        const mid = registry.listExecutions({ running: true });
        expect(mid).toHaveLength(1);
        expect(mid[0]?.status).toBe('running');
        expect(mid[0]?.source).toBe('supervisor');
        expect(mid[0]?.agentId).toBe('alpha-claude');
        expect(mid[0]?.pid).toBeGreaterThan(0);
        expect(proc.pid).toBe(mid[0]?.pid ?? null);

        proc.writeStdin('x\n');
        proc.endStdin();
        await expect(proc.exited).resolves.toBe(0);

        const after = registry.listExecutions();
        expect(after).toHaveLength(1);
        expect(after[0]?.status).toBe('exited');
        expect(after[0]?.exitCode).toBe(0);
    });

    test('failed runStreaming spawn still completes registry entry', () => {
        const registry = createInMemoryProcessRegistry();
        const exec = new NodeProcessExecutor({ registry });

        expect(() => exec.runStreaming({ command: 'definitely-not-a-real-binary-xyz-registry' })).toThrow();

        const listed = registry.listExecutions();
        expect(listed).toHaveLength(1);
        expect(listed[0]?.status).toBe('exited');
        expect(listed[0]?.exitCode).toBeNull();
    });

    test('without registry, executor behavior is unchanged', async () => {
        const result = await new NodeProcessExecutor().run({ command: 'echo', args: ['ok'] });
        expect(result.exitCode).toBe(0);
    });
});
