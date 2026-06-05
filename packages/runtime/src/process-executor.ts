import { isatty } from 'node:tty';
import { type Options as ExecaOptions, execa } from 'execa';

// ── Types ────────────────────────────────────────────────────────────────

/** Controls how stdout/stderr is captured: buffered in memory or streamed to the caller's terminal. */
export type OutputPolicy = { mode: 'buffered' } | { mode: 'stream'; isTTY?: boolean };

/** Shared configuration for a process executor (default timeout, output buffering, output policy). */
export interface ProcessExecutorConfig {
    defaultTimeout?: number;
    defaultMaxOutput?: number;
    output?: OutputPolicy;
    events?: ProcessEventSink;
    tracer?: TracerPort;
}

/** Options for spawning a child process. */
export interface ProcessOptions {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
    maxOutput?: number;
    label?: string;
    rejectOnError?: boolean;
    forceBuffered?: boolean;
}

/** Result of a completed child process, including exit code, captured output, and duration. */
export interface ProcessResult {
    command: string;
    args: string[];
    exitCode: number | null;
    stdout: string;
    stderr: string;
    signal?: string;
    durationMs: number;
}

/** Reason a process completion event was emitted. */
export type ProcessExitReason = 'exit' | 'signal' | 'timeout' | 'error';

/** Payload emitted for process execution observability. */
export interface ProcessEventDetail {
    command: string;
    args: string[];
    exitCode: number | null;
    signal?: string;
    durationMs: number;
    reason: ProcessExitReason;
    timestamp: string;
    label?: string;
    error?: string;
}

/** Zero-dependency structural event sink for process observability. */
export interface ProcessEventSink {
    emit(event: 'process.started' | 'process.exited', detail: ProcessEventDetail): void;
}

/** Typed process event map, consumable by `EventBus<ProcessEvents>` in higher layers. */
export type ProcessEvents = {
    'process.started': (detail: ProcessEventDetail) => void;
    'process.exited': (detail: ProcessEventDetail) => void;
};

/** Minimal structural tracing port; concrete adapters live above `ts-runtime`. */
export interface TracerPort {
    traceAsync<T>(name: string, fn: (span: unknown) => Promise<T>): Promise<T>;
}

/** Options for spawning a long-running interactive process. */
export interface PipeProcessOptions {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    label?: string;
}

/** Signal values accepted by subprocess kill. */
type BunSubprocess = ReturnType<typeof Bun.spawn>;

/** Signal values accepted by subprocess kill (e.g. 'SIGTERM', 'SIGKILL'). */
export type ProcessSignal = Parameters<BunSubprocess['kill']>[0];

/** Handle to a running pipe process with streaming stdout/stderr and stdin write support. */
export interface PipeProcess {
    readonly pid: number | null;
    readonly stdout: ReadableStream<Uint8Array> | null;
    readonly stderr: ReadableStream<Uint8Array> | null;
    readonly exited: Promise<number | null>;
    writeStdin(input: string | Uint8Array): void;
    endStdin(): void;
    kill(signal?: ProcessSignal): void;
}

// ── ProcessExecutor ───────────────────────────────────────────────────────

/**
 * Runtime-agnostic process executor wrapping `execa`.
 *
 * Every invocation supports timeout enforcement, output capture, and
 * configurable output policy (buffered vs streamed).
 */
export class ProcessExecutor {
    private readonly config: ProcessExecutorConfig;

    constructor(config: ProcessExecutorConfig = {}) {
        this.config = config;
    }

    /**
     * Run a command, buffered by default. Returns a structured {@link ProcessResult}.
     * Does NOT throw on non-zero exit codes unless `rejectOnError` is set.
     */
    async run(options: ProcessOptions): Promise<ProcessResult> {
        return this.trace('process.run', () => this.runUntraced(options));
    }

    private async runUntraced(options: ProcessOptions): Promise<ProcessResult> {
        const args = options.args ?? [];
        const execaOptions = buildExecaOptions({
            cwd: options.cwd,
            env: options.env,
            timeout: options.timeout ?? this.config.defaultTimeout,
            maxOutput: options.maxOutput ?? this.config.defaultMaxOutput,
            rejectOnError: options.rejectOnError ?? false,
            outputPolicy: this.config.output,
            forceBuffered: options.forceBuffered ?? false,
        });
        const startedAt = Date.now();
        this.emitProcessEvent('process.started', {
            command: options.command,
            args,
            exitCode: null,
            durationMs: 0,
            reason: 'exit',
            timestamp: new Date(startedAt).toISOString(),
            ...(options.label !== undefined ? { label: options.label } : {}),
        });

        try {
            const result = await execa(options.command, args, execaOptions);
            const processResult = {
                command: options.command,
                args,
                exitCode: result.exitCode ?? null,
                stdout: asString(result.stdout),
                stderr: asString(result.stderr),
                ...(result.signalDescription !== undefined ? { signal: result.signalDescription } : {}),
                durationMs: result.durationMs,
            };
            this.emitExitedFromResult(options, processResult, result);
            return processResult;
        } catch (error) {
            const failed = error as {
                exitCode?: number;
                stdout?: string | string[] | Uint8Array;
                stderr?: string | string[] | Uint8Array;
                signalDescription?: string;
                signal?: string;
                durationMs?: number;
                timedOut?: boolean;
                message?: string;
            };
            const processResult = {
                command: options.command,
                args,
                exitCode: failed.exitCode ?? null,
                stdout: asString(failed.stdout),
                stderr: asString(failed.stderr),
                ...(failed.signalDescription !== undefined
                    ? { signal: failed.signalDescription }
                    : failed.signal !== undefined
                      ? { signal: failed.signal }
                      : {}),
                durationMs: failed.durationMs ?? Date.now() - startedAt,
            };
            this.emitExitedFromResult(options, processResult, error, error);
            if (options.rejectOnError) throw error;
            return processResult;
        }
    }

    /**
     * Spawn a long-running interactive process with streaming I/O.
     *
     * Uses `Bun.spawn` for bidirectional pipe communication (stdin write,
     * stdout/stderr as ReadableStreams). Returns a {@link PipeProcess} handle.
     */
    runStreaming(options: PipeProcessOptions): PipeProcess {
        const args = options.args ?? [];
        void this.config.tracer?.traceAsync('process.runStreaming', async () => undefined).catch(() => undefined);
        try {
            const startedAt = Date.now();
            this.emitProcessEvent('process.started', {
                command: options.command,
                args,
                exitCode: null,
                durationMs: 0,
                reason: 'exit',
                timestamp: new Date(startedAt).toISOString(),
                ...(options.label !== undefined ? { label: options.label } : {}),
            });
            const subprocess = Bun.spawn({
                cmd: [options.command, ...args],
                stdin: 'pipe',
                stdout: 'pipe',
                stderr: 'pipe',
                ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
                ...(options.env !== undefined ? { env: options.env } : {}),
            });
            return new ObservedPipeProcess(new BunPipeProcess(subprocess), this.config.events, {
                command: options.command,
                args,
                startedAt,
                ...(options.label !== undefined ? { label: options.label } : {}),
            });
        } catch (error) {
            this.emitProcessEvent('process.exited', {
                command: options.command,
                args,
                exitCode: null,
                durationMs: 0,
                reason: 'error',
                timestamp: new Date().toISOString(),
                ...(options.label !== undefined ? { label: options.label } : {}),
                error: errorMessage(error),
            });
            throw error;
        }
    }

    private async trace<T>(name: string, fn: () => Promise<T>): Promise<T> {
        if (this.config.tracer === undefined) return await fn();
        return await this.config.tracer.traceAsync(name, async () => await fn());
    }

    private emitExitedFromResult(
        options: ProcessOptions,
        result: ProcessResult,
        completion: unknown,
        error?: unknown,
    ): void {
        const reason = isTimedOut(completion)
            ? 'timeout'
            : result.signal !== undefined
              ? 'signal'
              : error
                ? 'error'
                : 'exit';
        this.emitProcessEvent('process.exited', {
            command: result.command,
            args: result.args,
            exitCode: result.exitCode,
            ...(result.signal !== undefined ? { signal: result.signal } : {}),
            durationMs: result.durationMs,
            reason,
            timestamp: new Date().toISOString(),
            ...(options.label !== undefined ? { label: options.label } : {}),
            ...(error !== undefined ? { error: errorMessage(error) } : {}),
        });
    }

    private emitProcessEvent(event: 'process.started' | 'process.exited', detail: ProcessEventDetail): void {
        this.config.events?.emit(event, detail);
    }
}

class ObservedPipeProcess implements PipeProcess {
    private killedWith: ProcessSignal | undefined;

    readonly exited: Promise<number | null>;

    constructor(
        private readonly inner: PipeProcess,
        events: ProcessEventSink | undefined,
        context: {
            command: string;
            args: string[];
            startedAt: number;
            label?: string;
        },
    ) {
        this.exited = inner.exited.then((exitCode) => {
            events?.emit('process.exited', {
                command: context.command,
                args: context.args,
                exitCode,
                ...(this.killedWith !== undefined ? { signal: String(this.killedWith) } : {}),
                durationMs: Date.now() - context.startedAt,
                reason: this.killedWith !== undefined ? 'signal' : 'exit',
                timestamp: new Date().toISOString(),
                ...(context.label !== undefined ? { label: context.label } : {}),
            });
            return exitCode;
        });
    }

    get pid(): number | null {
        return this.inner.pid;
    }

    get stdout(): ReadableStream<Uint8Array> | null {
        return this.inner.stdout;
    }

    get stderr(): ReadableStream<Uint8Array> | null {
        return this.inner.stderr;
    }

    writeStdin(input: string | Uint8Array): void {
        this.inner.writeStdin(input);
    }

    endStdin(): void {
        this.inner.endStdin();
    }

    kill(signal?: ProcessSignal): void {
        this.killedWith = signal;
        this.inner.kill(signal);
    }
}

// ── BunPipeProcess (internal) ─────────────────────────────────────────────

type StdinSink = {
    write: (data: string | Uint8Array) => unknown;
    end?: () => unknown;
    flush?: () => unknown;
};

class BunPipeProcess implements PipeProcess {
    private readonly writer: StdinSink;

    constructor(private readonly subprocess: BunSubprocess) {
        this.writer = subprocess.stdin as StdinSink;
    }

    get pid(): number | null {
        return this.subprocess.pid ?? null;
    }

    get stdout(): ReadableStream<Uint8Array> | null {
        return isReadableStream(this.subprocess.stdout) ? this.subprocess.stdout : null;
    }

    get stderr(): ReadableStream<Uint8Array> | null {
        return isReadableStream(this.subprocess.stderr) ? this.subprocess.stderr : null;
    }

    get exited(): Promise<number | null> {
        return this.subprocess.exited;
    }

    writeStdin(input: string | Uint8Array): void {
        this.writer.write(input);
        this.writer.flush?.();
    }

    endStdin(): void {
        this.writer.end?.();
    }

    kill(signal?: ProcessSignal): void {
        this.subprocess.kill(signal);
    }
}

// ── Deprecated backward-compatible subclasses ─────────────────────────────

/**
 * @deprecated Use {@link ProcessExecutor} directly.
 * This subclass is kept for backward compatibility.
 */
export class NodeProcessExecutor extends ProcessExecutor {}

/**
 * @deprecated Use `Bun.spawnSync` or `child_process.spawnSync` directly.
 * Synchronous process execution is no longer recommended from ts-runtime.
 * This class is kept for backward compatibility.
 */
export class BunSyncProcessExecutor {
    runSync(options: Omit<ProcessOptions, 'timeout'>): ProcessResult {
        const args = options.args ?? [];
        const startedAt = Date.now();
        const result = Bun.spawnSync({
            cmd: [options.command, ...args],
            stdout: 'pipe',
            stderr: 'pipe',
            stdin: 'ignore',
            ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
            ...(options.env !== undefined ? { env: options.env } : {}),
        });
        if (options.rejectOnError === true && result.exitCode !== 0) {
            throw new Error(
                `${options.command} ${args.join(' ')} failed with exit code ${result.exitCode}: ${stripFinalNewline(
                    asString(result.stderr),
                )}`,
            );
        }
        return {
            command: options.command,
            args,
            exitCode: result.exitCode,
            stdout: stripFinalNewline(asString(result.stdout)),
            stderr: stripFinalNewline(asString(result.stderr)),
            durationMs: Date.now() - startedAt,
        };
    }
}

/**
 * @deprecated Use {@link ProcessExecutor.runStreaming} instead.
 * This class is kept for backward compatibility.
 */
export class BunPipeProcessSpawner {
    spawn(options: PipeProcessOptions): PipeProcess {
        const subprocess = Bun.spawn({
            cmd: [options.command, ...(options.args ?? [])],
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
            ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
            ...(options.env !== undefined ? { env: options.env } : {}),
        });
        return new BunPipeProcess(subprocess);
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function buildExecaOptions(opts: {
    cwd: string | undefined;
    env: Record<string, string> | undefined;
    timeout: number | undefined;
    maxOutput: number | undefined;
    rejectOnError: boolean;
    outputPolicy: OutputPolicy | undefined;
    forceBuffered: boolean;
}): ExecaOptions {
    const canStream =
        !opts.forceBuffered &&
        opts.outputPolicy?.mode === 'stream' &&
        (opts.outputPolicy.isTTY ?? process.stdout.isTTY ?? isatty(1));

    return {
        reject: opts.rejectOnError,
        stdin: 'ignore',
        stripFinalNewline: true,
        ...(canStream ? { stdout: ['inherit', 'pipe'] as const, stderr: ['inherit', 'pipe'] as const } : { all: true }),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
        ...(opts.maxOutput !== undefined ? { maxBuffer: opts.maxOutput } : {}),
    };
}

function asString(value: string | string[] | unknown[] | Uint8Array | undefined): string {
    if (typeof value === 'string') return value;
    if (value instanceof Uint8Array) return new TextDecoder().decode(value);
    if (Array.isArray(value)) return value.map(String).join('');
    return '';
}

function stripFinalNewline(value: string): string {
    return value.endsWith('\r\n') ? value.slice(0, -2) : value.endsWith('\n') ? value.slice(0, -1) : value;
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
    return value instanceof ReadableStream;
}

function isTimedOut(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'timedOut' in error && error.timedOut === true;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
