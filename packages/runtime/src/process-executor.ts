import { isatty } from 'node:tty';
import { type Options as ExecaOptions, execa } from 'execa';
import type { ProcessExecutionSource, ProcessRegistry } from './process-registry';
import type { RuntimePaths } from './runtime-paths';

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
    /**
     * Optional process registry (spur#0264). When set, every `run` / `runStreaming`
     * invocation is recorded for list/subscribe consumers (e.g. Spur Processes tab).
     * Share one registry across all executors that should appear in the same watch list.
     */
    registry?: ProcessRegistry;
    /**
     * Optional cwd/home anchor (ADR-023 A1 / task 0042). When set, `paths.cwd` is applied to
     * any `run` that carries no explicit per-call `cwd`. Precedence is total:
     * explicit per-call `cwd` > injected `paths.cwd` > ambient process cwd.
     */
    paths?: RuntimePaths;
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
    /**
     * AbortSignal forwarded to execa and, on Unix, to the child's isolated
     * process group so descendants cannot outlive a cancelled one-shot run.
     */
    signal?: AbortSignal;
    /**
     * Optional non-blocking observer for incremental stdout/stderr.
     *
     * The executor invokes this synchronously from the child stream and isolates
     * observer failures. Consumers must enqueue and return; the buffered
     * {@link ProcessResult} remains authoritative.
     */
    onOutput?: (output: ProcessOutputChunk) => void;
    /**
     * Optional observer invoked once with the OS pid as soon as the child is
     * spawned, for callers that need to identify the subprocess while it is
     * still running (progress lines, `kill` targets, `ps` correlation).
     *
     * The buffered {@link ProcessResult} cannot carry this: execa@9 resolves
     * only after exit, by which point the pid is historical. Failures are
     * isolated — observation cannot change process semantics.
     */
    onSpawn?: (pid: number) => void;
    /**
     * Registry metadata (spur#0264). Defaults: source `'one-shot'` for `run`.
     * Pass `source: 'supervisor'` (and optional teamId/agentId) when the spawn is
     * a supervised team agent loop.
     */
    source?: ProcessExecutionSource;
    teamId?: string;
    agentId?: string;
}

/** One incremental process-output observation. */
export interface ProcessOutputChunk {
    readonly stream: 'stdout' | 'stderr';
    readonly chunk: string;
    readonly timestamp: string;
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
    /**
     * Registry metadata (spur#0264). Defaults: source `'other'` for streaming.
     * Supervised agent loops should pass `source: 'supervisor'` + agentId.
     */
    source?: ProcessExecutionSource;
    teamId?: string;
    agentId?: string;
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

// ── ProcessExecutor (canonical interface) ────────────────────────────────

/**
 * Runtime-agnostic process executor contract.
 *
 * Every invocation supports timeout enforcement, output capture, and
 * configurable output policy (buffered vs streamed). Concrete implementations
 * are obtained through `RuntimeFactory.createProcessExecutor`; the Node/Bun
 * implementation is {@link NodeProcessExecutor}. Test doubles implement this
 * interface structurally — no concrete subclassing required.
 */
export interface ProcessExecutor {
    /**
     * Run a command, buffered by default. Returns a structured {@link ProcessResult}.
     * Does NOT throw on non-zero exit codes unless `rejectOnError` is set.
     */
    run(options: ProcessOptions): Promise<ProcessResult>;

    /**
     * Spawn a long-running interactive process with streaming I/O.
     *
     * Returns a {@link PipeProcess} handle with streaming stdout/stderr and
     * stdin write support.
     */
    runStreaming(options: PipeProcessOptions): PipeProcess;
}

// ── NodeProcessExecutor (concrete Node/Bun implementation) ───────────────

/**
 * Concrete Node/Bun implementation of {@link ProcessExecutor}, wrapping `execa`
 * for buffered execution and `Bun.spawn` for streaming pipe execution.
 *
 * Obtain a default instance through `RuntimeFactory.createProcessExecutor`
 * (e.g. `nodeBunFactory.createProcessExecutor()`); construct directly only in
 * runtime-factory wiring or concrete implementation tests.
 */
export class NodeProcessExecutor implements ProcessExecutor {
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
            cwd: options.cwd ?? this.config.paths?.cwd,
            env: options.env,
            timeout: options.timeout ?? this.config.defaultTimeout,
            maxOutput: options.maxOutput ?? this.config.defaultMaxOutput,
            rejectOnError: options.rejectOnError ?? false,
            outputPolicy: this.config.output,
            forceBuffered: options.forceBuffered ?? false,
            signal: options.signal,
        });
        const startedAt = Date.now();
        const startedIso = new Date(startedAt).toISOString();
        const registryId = this.beginRegistry(options.command, args, {
            label: options.label,
            source: options.source ?? 'one-shot',
            teamId: options.teamId,
            agentId: options.agentId,
            startedAt: startedIso,
        });
        this.emitProcessEvent('process.started', {
            command: options.command,
            args,
            exitCode: null,
            durationMs: 0,
            reason: 'exit',
            timestamp: startedIso,
            ...(options.label !== undefined ? { label: options.label } : {}),
        });

        try {
            const subprocess = execa(options.command, args, execaOptions);
            // execa@9's resolved Result carries no pid, but the live handle does.
            // Publish it while the child is running so observers can identify the
            // subprocess, and record it against the registry entry opened above.
            if (subprocess.pid !== undefined) {
                this.config.registry?.update(registryId, { pid: subprocess.pid });
                if (options.onSpawn !== undefined) {
                    try {
                        options.onSpawn(subprocess.pid);
                    } catch {
                        // Spawn observation cannot change process semantics.
                    }
                }
            }
            const stopGroupCancellation = observeProcessGroupCancellation(subprocess, options.signal);
            observeOutput(subprocess.stdout, 'stdout', options.onOutput);
            observeOutput(subprocess.stderr, 'stderr', options.onOutput);
            const result = await subprocess.finally(stopGroupCancellation);
            const processResult = {
                command: options.command,
                args,
                exitCode: result.exitCode ?? null,
                stdout: asString(result.stdout),
                stderr: asString(result.stderr),
                ...(result.signalDescription !== undefined ? { signal: result.signalDescription } : {}),
                durationMs: result.durationMs,
            };
            this.completeRegistry(registryId, processResult.exitCode);
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
            this.completeRegistry(registryId, processResult.exitCode);
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
        const startedAt = Date.now();
        const startedIso = new Date(startedAt).toISOString();
        // Begin registry before spawn so failed spawns still appear (then complete as error).
        const registryId = this.beginRegistry(options.command, args, {
            label: options.label,
            source: options.source ?? 'other',
            teamId: options.teamId,
            agentId: options.agentId,
            startedAt: startedIso,
        });
        try {
            this.emitProcessEvent('process.started', {
                command: options.command,
                args,
                exitCode: null,
                durationMs: 0,
                reason: 'exit',
                timestamp: startedIso,
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
            const pipe = new BunPipeProcess(subprocess);
            if (pipe.pid !== null) {
                this.config.registry?.update(registryId, { pid: pipe.pid });
            }
            return new ObservedPipeProcess(pipe, this.config.events, {
                command: options.command,
                args,
                startedAt,
                registry: this.config.registry,
                registryId,
                ...(options.label !== undefined ? { label: options.label } : {}),
            });
        } catch (error) {
            this.completeRegistry(registryId, null);
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

    private beginRegistry(
        command: string,
        args: string[],
        meta: {
            label?: string;
            source: ProcessExecutionSource;
            teamId?: string;
            agentId?: string;
            startedAt: string;
        },
    ): string {
        const registry = this.config.registry;
        if (!registry) return '';
        return registry.begin({
            command,
            args,
            source: meta.source,
            startedAt: meta.startedAt,
            ...(meta.label !== undefined ? { label: meta.label } : {}),
            ...(meta.teamId !== undefined ? { teamId: meta.teamId } : {}),
            ...(meta.agentId !== undefined ? { agentId: meta.agentId } : {}),
        });
    }

    private completeRegistry(id: string, exitCode: number | null, pid?: number): void {
        if (!id || !this.config.registry) return;
        this.config.registry.complete(id, {
            exitCode,
            ...(pid !== undefined ? { pid } : {}),
        });
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
            registry?: ProcessRegistry;
            registryId: string;
        },
    ) {
        this.exited = inner.exited.then((exitCode) => {
            if (context.registry && context.registryId) {
                context.registry.complete(context.registryId, {
                    exitCode,
                    ...(inner.pid !== null ? { pid: inner.pid } : {}),
                });
            }
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

// ── Deprecated constructible ProcessExecutor value alias ──────────────────

/**
 * @deprecated Construct {@link NodeProcessExecutor} directly or obtain a default
 * through `RuntimeFactory.createProcessExecutor` (e.g. `nodeBunFactory.createProcessExecutor()`).
 * This value alias preserves source compatibility for `new ProcessExecutor(...)` callers
 * during the interface extraction release; it will be removed in a future release.
 * `import type { ProcessExecutor }` resolves to the canonical interface, not this alias.
 */
export const ProcessExecutor = NodeProcessExecutor;

// ── Deprecated backward-compatible helpers ────────────────────────────────

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
    signal?: AbortSignal;
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
        ...(opts.signal !== undefined
            ? {
                  cancelSignal: opts.signal,
                  // Node's negative-pid group signal requires the child to lead
                  // a distinct process group. Windows has no equivalent.
                  ...(process.platform !== 'win32' ? { detached: true } : {}),
              }
            : {}),
    };
}

function observeProcessGroupCancellation(
    subprocess: { pid?: number; kill(signal?: NodeJS.Signals | number): boolean },
    signal: AbortSignal | undefined,
): () => void {
    const pid = subprocess.pid;
    if (signal === undefined || process.platform === 'win32' || pid === undefined) return () => {};
    const abort = (): void => {
        try {
            process.kill(-pid, 'SIGTERM');
        } catch {
            // The leader may already have exited through execa's cancelSignal.
            // Fall back to the direct child without changing cancellation semantics.
            subprocess.kill('SIGTERM');
        }
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    return () => signal.removeEventListener('abort', abort);
}

function observeOutput(
    stream: NodeJS.ReadableStream | null | undefined,
    name: ProcessOutputChunk['stream'],
    observer: ProcessOptions['onOutput'],
): void {
    if (!stream || !observer) return;
    stream.on('data', (chunk: string | Uint8Array) => {
        try {
            observer({
                stream: name,
                chunk: asString(chunk),
                timestamp: new Date().toISOString(),
            });
        } catch {
            // Observability is best-effort and must never interrupt child I/O.
        }
    });
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
