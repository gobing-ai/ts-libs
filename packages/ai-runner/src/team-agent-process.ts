import { Buffer } from 'node:buffer';
import { type EventBus, getLogger, type Logger } from '@gobing-ai/ts-infra';
import { nodeBunFactory, type PipeProcess, type ProcessExecutor } from '@gobing-ai/ts-runtime';
import type { AgentSpec } from './agent-spec';
import type { AgentEvents } from './events';
import {
    buildQuotaObservation,
    classifyQuotaErrorRecord,
    MAX_QUOTA_EVIDENCE_BYTES,
    type QuotaAttribution,
    QuotaObservationProducer,
} from './quota';

/** Options for spawning a team agent subprocess. */
export interface AgentProcessOptions {
    spec: AgentSpec;
    command: string[];
    env?: Record<string, string>;
    cwd?: string;
    processExecutor?: ProcessExecutor;
    logger?: Logger;
    /** Optional agent event bus; when present, confirmed quota failures emit `agent.quota.exhausted` (Spur task 0798). */
    events?: EventBus<AgentEvents>;
    /** Optional exact quota attribution; absent fields stay absent on observations — never inferred. */
    quotaContext?: QuotaAttribution;
}

type ProcessStatus = 'running' | 'stopped' | 'errored';

/**
 * Manages the lifecycle of a single agent subprocess — start, stop, message send, and stdout/stderr subscription.
 * The identity preamble is built by `TeamOrchestrator` and baked into `command` before the process is constructed.
 */
export class TeamAgentProcess {
    readonly agentId: string;
    private readonly command: string[];
    private readonly env: Record<string, string> | undefined;
    private readonly cwd: string | undefined;
    private readonly processExecutor: ProcessExecutor;
    private readonly logger: Logger;
    private subprocess: PipeProcess | null = null;
    private status: ProcessStatus = 'stopped';
    private exitCode: number | null = null;
    private readonly subscribers = new Set<(data: Buffer) => void>();
    /** Bounded trailing stderr window retained for quota classification — never a full transcript. */
    private stderrTail = '';
    private readonly quotaProducer: QuotaObservationProducer;
    private readonly spec: AgentSpec;
    private readonly quotaContext: QuotaAttribution | undefined;

    constructor(options: AgentProcessOptions) {
        this.agentId = options.spec.id;
        this.command = options.command;
        this.env = options.env;
        this.cwd = options.cwd ?? options.spec.workspace;
        this.processExecutor = options.processExecutor ?? nodeBunFactory.createProcessExecutor();
        this.logger = options.logger ?? getLogger('team-agent');
        this.quotaProducer = new QuotaObservationProducer(options.events);
        this.spec = options.spec;
        this.quotaContext = options.quotaContext;
    }

    async start(): Promise<void> {
        if (this.status === 'running') return;
        const [command, ...args] = this.command;
        if (command === undefined) throw new Error(`${this.agentId}: command must not be empty`);
        this.subprocess = this.processExecutor.runStreaming({
            command,
            args,
            label: `team-agent.${this.agentId}`,
            ...(this.cwd !== undefined ? { cwd: this.cwd } : {}),
            ...(this.env !== undefined ? { env: this.env } : {}),
        });
        this.status = 'running';
        this.exitCode = null;
        this.stderrTail = '';
        if (this.subprocess.stdout !== null) this.pipe(this.subprocess.stdout, false);
        if (this.subprocess.stderr !== null) this.pipe(this.subprocess.stderr, true);
        void this.subprocess.exited.then((code) => {
            this.exitCode = code;
            if (this.status === 'running') {
                this.status = code === 0 ? 'stopped' : 'errored';
                if (this.status === 'errored') this.classifyQuota();
            }
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
        } catch (error) {
            this.warn('stdin close failed', 'stop.endStdin', error);
        }
        process.kill('SIGTERM');
        const timeout = new Promise<'timeout'>((resolve) => {
            setTimeout(() => resolve('timeout'), 5000);
        });
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
        if (this.status !== 'running' || this.subprocess === null) {
            this.warn('send skipped because process is not running', 'send.notRunning');
            return { ok: false };
        }
        try {
            this.subprocess.writeStdin(`${message}\n`);
            return { ok: true };
        } catch (error) {
            this.warn('stdin write failed', 'send.writeStdin', error);
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

    private async pipe(stream: ReadableStream<Uint8Array>, isStderr: boolean): Promise<void> {
        const reader = stream.getReader();
        try {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                const buffer = Buffer.from(chunk.value);
                if (isStderr) this.retainStderrTail(buffer.toString('utf8'));
                for (const subscriber of this.subscribers) subscriber(buffer);
            }
        } catch (error) {
            this.warn('stream pipe failed', 'pipe', error);
            if (this.status === 'running') this.status = 'errored';
        } finally {
            reader.releaseLock();
        }
    }

    /** Keep only the trailing {@link MAX_QUOTA_EVIDENCE_BYTES} of stderr; subscribers still see every chunk unchanged. */
    private retainStderrTail(text: string): void {
        this.stderrTail = (this.stderrTail + text).slice(-MAX_QUOTA_EVIDENCE_BYTES);
    }

    /** Classify the retained stderr window and emit one attributed quota observation on confirmation. */
    private classifyQuota(): void {
        const classification = classifyQuotaErrorRecord(this.stderrTail);
        if (!classification.quota) return;
        this.quotaProducer.produce(
            buildQuotaObservation({
                source: 'streaming-error',
                reason: classification.reason,
                attribution: {
                    ...this.quotaContext,
                    agent: this.quotaContext?.agent ?? this.spec.id,
                    executor: this.quotaContext?.executor ?? this.spec.executor ?? this.spec.type,
                },
            }),
        );
    }

    private warn(message: string, op: string, error?: unknown): void {
        this.logger.warn(message, {
            agentId: this.agentId,
            op,
            ...(error !== undefined ? { error: error instanceof Error ? error.message : String(error) } : {}),
        });
    }
}
