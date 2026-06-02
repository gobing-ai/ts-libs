import { describe, expect, test } from 'bun:test';
import type { PipeProcess, PipeProcessSpawner } from '@gobing-ai/ts-runtime';
import { type AgentSpec, TeamAgentProcess } from '../src';

const spec: AgentSpec = {
    id: 'coder',
    name: 'Coder',
    type: 'codex',
    workspace: process.cwd(),
    purpose: 'Echo messages',
    tags: [],
    config: {},
};

describe('TeamAgentProcess', () => {
    test('starts, sends stdin, publishes output, and stops', async () => {
        const process = new TeamAgentProcess({
            spec,
            command: [
                'bun',
                '-e',
                "process.stdin.on('data', (chunk) => process.stdout.write(chunk)); setInterval(() => {}, 1000);",
            ],
        });
        const output: string[] = [];
        const unsubscribe = process.subscribe((data) => output.push(data.toString()));

        await process.start();
        expect(process.getStatus()).toBe('running');
        expect(process.getPid()).toBeGreaterThan(0);

        expect(await process.send('hello')).toEqual({ ok: true });
        await waitFor(() => output.join('').includes('hello'));
        await process.stop();
        unsubscribe();

        expect(process.getStatus()).toBe('stopped');
        expect(process.getPid()).toBeNull();
        expect(process.getExitCode()).not.toBeNull();
    });

    test('send fails when process is not running', async () => {
        const process = new TeamAgentProcess({ spec, command: ['bun', '--version'] });
        expect(await process.send('hello')).toEqual({ ok: false });
    });

    test('reports natural non-zero exits as errored', async () => {
        const process = new TeamAgentProcess({
            spec,
            command: ['bun', '-e', 'process.exit(7)'],
        });
        await process.start();
        await waitFor(() => process.getExitCode() === 7);
        expect(process.getStatus()).toBe('errored');
    });

    test('uses injected spawner and marks write failures errored', async () => {
        const fakeProcess = new FakePipeProcess({ writeThrows: true });
        const spawner = new FakeSpawner(fakeProcess);
        const process = new TeamAgentProcess({ spec, command: ['fake'], processSpawner: spawner });

        await process.start();
        await process.start();
        expect(spawner.spawnCount).toBe(1);
        expect(await process.send('hello')).toEqual({ ok: false });
        expect(process.getStatus()).toBe('errored');
    });

    test('stop is a no-op before start', async () => {
        const process = new TeamAgentProcess({ spec, command: ['fake'], processSpawner: new FakeSpawner() });
        await process.stop();
        expect(process.getStatus()).toBe('stopped');
    });
});

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
        if (predicate()) return;
        await Bun.sleep(20);
    }
    throw new Error('Timed out waiting for condition');
}

class FakeSpawner implements PipeProcessSpawner {
    spawnCount = 0;

    constructor(private readonly process = new FakePipeProcess()) {}

    spawn(): PipeProcess {
        this.spawnCount += 1;
        return this.process;
    }
}

class FakePipeProcess implements PipeProcess {
    readonly pid = 123;
    readonly stdout = null;
    readonly stderr = null;
    readonly exited = new Promise<number | null>(() => {});

    constructor(private readonly options: { writeThrows?: boolean } = {}) {}

    writeStdin(): void {
        if (this.options.writeThrows === true) throw new Error('stdin closed');
    }

    endStdin(): void {}

    kill(): void {}
}
