import { Buffer } from 'node:buffer';
import { BunPipeProcessSpawner, type PipeProcess, type PipeProcessSpawner } from '@gobing-ai/ts-runtime';
import type { AgentSpec } from './agent-spec';
import { buildIdentityPreamble } from './identity';

/** Options for spawning a team agent subprocess. */
export interface AgentProcessOptions {
    spec: AgentSpec;
    command: string[];
    env?: Record<string, string>;
    cwd?: string;
    processSpawner?: PipeProcessSpawner;
}

type ProcessStatus = 'running' | 'stopped' | 'errored';

/**
 * Manages the lifecycle of a single agent subprocess — start, stop, message send, and stdout/stderr subscription.
 * Injects the agent identity preamble into the process on construction.
 */
export class TeamAgentProcess {
    readonly agentId: string;
    readonly identityPreamble: string;
    private readonly command: string[];
    private readonly env: Record<string, string> | undefined;
    private readonly cwd: string | undefined;
    private readonly processSpawner: PipeProcessSpawner;
    private subprocess: PipeProcess | null = null;
    private status: ProcessStatus = 'stopped';
    private exitCode: number | null = null;
    private readonly subscribers = new Set<(data: Buffer) => void>();

    constructor(options: AgentProcessOptions) {
        this.agentId = options.spec.id;
        this.identityPreamble = buildIdentityPreamble({
            agentId: options.spec.id,
            agentType: options.spec.type,
            workspace: options.spec.workspace,
            purpose: options.spec.purpose,
            systemPrompt:
                typeof options.spec.config.systemPrompt === 'string' ? options.spec.config.systemPrompt : undefined,
        });
        this.command = options.command;
        this.env = options.env;
        this.cwd = options.cwd ?? options.spec.workspace;
        this.processSpawner = options.processSpawner ?? new BunPipeProcessSpawner();
    }

    async start(): Promise<void> {
        if (this.status === 'running') return;
        const [command, ...args] = this.command;
        if (command === undefined) throw new Error(`${this.agentId}: command must not be empty`);
        this.subprocess = this.processSpawner.spawn({
            command,
            args,
            ...(this.cwd !== undefined ? { cwd: this.cwd } : {}),
            ...(this.env !== undefined ? { env: this.env } : {}),
        });
        this.status = 'running';
        this.exitCode = null;
        if (this.subprocess.stdout !== null) this.pipe(this.subprocess.stdout);
        if (this.subprocess.stderr !== null) this.pipe(this.subprocess.stderr);
        void this.subprocess.exited.then((code) => {
            this.exitCode = code;
            if (this.status === 'running') this.status = code === 0 ? 'stopped' : 'errored';
        });
    }

    async stop(): Promise<void> {
        const process = this.subprocess;
        if (process === null) {
            this.status = 'stopped';
            return;
        }
        try {
            process.endStdin();
        } catch {
            // Process may have already closed stdin.
        }
        process.kill('SIGTERM');
        const timeout = Bun.sleep(5000).then(() => 'timeout' as const);
        const result = await Promise.race([process.exited, timeout]);
        if (result === 'timeout') {
            process.kill('SIGKILL');
            this.exitCode = await process.exited;
        } else {
            this.exitCode = result;
        }
        this.status = 'stopped';
        this.subprocess = null;
    }

    async send(message: string): Promise<{ ok: boolean }> {
        if (this.status !== 'running' || this.subprocess === null) return { ok: false };
        try {
            this.subprocess.writeStdin(`${message}\n`);
            return { ok: true };
        } catch {
            this.status = 'errored';
            return { ok: false };
        }
    }

    subscribe(callback: (data: Buffer) => void): () => void {
        this.subscribers.add(callback);
        return () => {
            this.subscribers.delete(callback);
        };
    }

    getStatus(): ProcessStatus {
        return this.status;
    }

    getPid(): number | null {
        return this.subprocess?.pid ?? null;
    }

    getExitCode(): number | null {
        return this.exitCode;
    }

    private async pipe(stream: ReadableStream<Uint8Array>): Promise<void> {
        const reader = stream.getReader();
        try {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                const buffer = Buffer.from(chunk.value);
                for (const subscriber of this.subscribers) subscriber(buffer);
            }
        } catch {
            if (this.status === 'running') this.status = 'errored';
        } finally {
            reader.releaseLock();
        }
    }
}
