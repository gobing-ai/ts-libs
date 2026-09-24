import { isatty } from 'node:tty';
import { type Options as ExecaOptions, execa } from 'execa';
import { getProcessEnv } from './config';
import type { ProcessExecutionSource, ProcessRegistry } from './process-registry';
import type { RuntimePaths } from './runtime-paths';

// ── Types ────────────────────────────────────────────────────────────────

/**
 * Controls how stdout/stderr is captured: buffered in memory, streamed to the
 * caller's terminal, or piped without TTY inherit.
 *
 * - `{ mode: 'buffered' }` — end-buffered capture (`all: true`). `onOutput`
 *   may observe, but the model is a completed result.
 * - `{ mode: 'stream', isTTY? }` — inherit the terminal AND pipe, so chunks
 *   render live. Requires a TTY (defaults to the parent's stdout TTY status).
 * - `{ mode: 'pipe' }` — pipe stdout/stderr to the caller with **no TTY
 *   inherit** and stdin ignored. `onOutput` fires as chunks arrive (mid-run),
 *   distinct from both TTY stream-inherit and end-buffered `all: true`.
 *   This is the non-interactive live-output policy for pipeline agent runs
 *   (ADR-047): no interactive prompt, no terminal capture, live data events.
 */
export type OutputPolicy = { mode: 'buffered' } | { mode: 'stream'; isTTY?: boolean } | { mode: 'pipe' };

/** Shared configuration for a process executor (default timeout, output buffering, output policy). */
export interface ProcessExecutorConfig {
    /**
     * Default execution deadline inherited by runs that omit `timeout`. `null` makes the
     * default policy unlimited; value validation follows `ProcessOptions.timeout`.
     */
    defaultTimeout?: number | null;
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
    /**
     * `'merge'` (default): a partial `env` extends the parent environment (execa
     * `extendEnv: true` semantics). `'replace'`: the child gets exactly `env` and
     * none of the parent variables. Task 0060 R5 unified the default to merge so
     * `run` and `runStreaming` share one contract.
     */
    envMode?: 'merge' | 'replace';
    /**
     * Execution deadline in milliseconds. Omitted inherits
     * {@link ProcessExecutorConfig.defaultTimeout}; explicit `null` runs without a deadline
     * (a supplied `signal` still cancels). On Unix, a finite deadline activates owned
     * process-group containment: the executor arms its own timer — callers must not race a
     * second watchdog — and expiry reaps the whole group with SIGTERM-to-SIGKILL escalation.
     * Zero, negative, fractional, non-finite, or beyond-timer-range values are rejected
     * before spawn; `null` replaces the previous `0`-disables behavior.
     */
    timeout?: number | null;
    /**
     * Grace in milliseconds between the owned group SIGTERM and the SIGKILL escalation
     * (Unix group containment; see {@link ProcessOptions.timeout}). `0` escalates
     * immediately; omitted defaults to 5000 ms. Out-of-range values are rejected before
     * spawn. Without a finite deadline or `signal`, this option has no effect.
     */
    killGraceMs?: number;
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

/**
 * Terminal classification of how a run ended: normal `exit`, deadline `timeout`, external
 * `cancelled` abort, termination by an outside `signal`, or `error` (spawn/runtime failure).
 * Reaping surviving owned descendants after a natural leader exit keeps the outcome `exit`.
 */
export type ProcessOutcome = 'exit' | 'timeout' | 'cancelled' | 'signal' | 'error';

/** Result of a completed child process, including exit code, captured output, and duration. */
export interface ProcessResult {
    command: string;
    args: string[];
    exitCode: number | null;
    stdout: string;
    stderr: string;
    signal?: string;
    durationMs: number;
    /**
     * How the run terminated, distinguishing deadline expiry from external cancellation,
     * an outside signal, runtime failure, and normal completion. Optional for backward
     * compatibility with hand-built results; `NodeProcessExecutor` always sets it.
     */
    outcome?: ProcessOutcome;
}

/** Reason a process completion event was emitted (mirrors {@link ProcessOutcome}). */
export type ProcessExitReason = ProcessOutcome;

function processEventSeverity(reason: ProcessExitReason, exitCode: number | null): ProcessEventDetail['severity'] {
    if (reason === 'error') return 'error';
    if (reason === 'timeout' || reason === 'cancelled') return 'warning';
    if (exitCode !== null && exitCode !== 0) return 'warning';
    return 'info';
}

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
    /** Producer-owned observability severity. */
    severity: 'info' | 'warning' | 'error';
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
    /**
     * `'merge'` (default): a partial `env` extends the parent environment, matching
     * {@link ProcessExecutor.run}. `'replace'`: the child gets exactly `env`.
     * Previously `runStreaming` always replaced; task 0060 R5 made merge the default.
     */
    envMode?: 'merge' | 'replace';
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

/**
 * Resolve the child env per the unified contract (task 0060 R5): a partial env
 * extends the parent environment unless `envMode: 'replace'` opts out. Parent
 * values can be `undefined` (deleted keys) — Bun's env is string-only, so filter them.
 */
function resolveChildEnv(
    env: Record<string, string>,
    envMode: 'merge' | 'replace' | undefined,
): Record<string, string> {
    if (envMode === 'replace') return env;
    const merged: Record<string, string> = {};
    for (const [key, value] of Object.entries(getProcessEnv())) {
        if (value !== undefined) merged[key] = value;
    }
    return { ...merged, ...env };
}

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
        // Validate before spawn and before any registry/event side effects: an invalid
        // deadline or grace is caller configuration error, not a process outcome.
        const deadline = resolveDeadline(options.timeout, this.config.defaultTimeout);
        const killGraceMs = resolveKillGraceMs(options.killGraceMs);
        // Unix group containment activates on a finite deadline or a caller abort signal:
        // the executor then owns group isolation, SIGTERM, escalation, output settlement
        // and the final outcome, so callers must not arm a competing watchdog. Other
        // platforms keep execa's direct-child timeout/cancellation semantics explicit.
        const groupOwned =
            process.platform !== 'win32' && (typeof deadline === 'number' || options.signal !== undefined);
        const execaOptions = buildExecaOptions({
            cwd: options.cwd ?? this.config.paths?.cwd,
            env: options.env,
            timeout: typeof deadline === 'number' ? deadline : undefined,
            maxOutput: options.maxOutput ?? this.config.defaultMaxOutput,
            rejectOnError: options.rejectOnError ?? false,
            outputPolicy: this.config.output,
            forceBuffered: options.forceBuffered ?? false,
            signal: options.signal,
            groupOwned,
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
            severity: 'info',
            ...(options.label !== undefined ? { label: options.label } : {}),
        });

        let ownership: ProcessGroupOwnership | undefined;
        try {
            const subprocess = execa(options.command, args, execaOptions);
            if (groupOwned && subprocess.pid !== undefined) {
                ownership = ownProcessGroupLifecycle({
                    pid: subprocess.pid,
                    deadlineMs: typeof deadline === 'number' ? deadline : undefined,
                    signal: options.signal,
                    graceMs: killGraceMs,
                });
            }
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
            const stopOwnedTermination = (): void => ownership?.stop();
            observeOutput(subprocess.stdout, 'stdout', options.onOutput);
            observeOutput(subprocess.stderr, 'stderr', options.onOutput);
            const result = await subprocess.finally(stopOwnedTermination);
            // Settle the owned termination path before reporting: a deadline or abort that
            // fired keeps escalating until the group is empty, and a natural leader exit
            // reaps surviving owned descendants so completion cannot leak pipes or locks.
            const ownedOutcome = ownership !== undefined ? await ownership.finish() : undefined;
            const processResult = {
                command: options.command,
                args,
                exitCode: result.exitCode ?? null,
                stdout: asString(result.stdout),
                stderr: asString(result.stderr),
                ...(result.signalDescription !== undefined ? { signal: result.signalDescription } : {}),
                durationMs: result.durationMs,
                outcome:
                    ownedOutcome ?? (result.signalDescription !== undefined ? ('signal' as const) : ('exit' as const)),
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
                isCanceled?: boolean;
                isTerminated?: boolean;
                message?: string;
            };
            // Termination containment settles before the failure is reported — and before
            // rejectOnError rethrows — so a rejected run never leaks owned descendants.
            const ownedOutcome = ownership !== undefined ? await ownership.finish() : undefined;
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
                outcome: ownedOutcome ?? classifyFailedCompletion(failed),
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
        // Task 0086 R14: no lifetime span here — the empty fire-and-forget span
        // carried no data and confused span consumers. Registry + events cover it.
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
                severity: 'info',
                ...(options.label !== undefined ? { label: options.label } : {}),
            });
            const subprocess = Bun.spawn({
                cmd: [options.command, ...args],
                stdin: 'pipe',
                stdout: 'pipe',
                stderr: 'pipe',
                ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
                ...(options.env !== undefined ? { env: resolveChildEnv(options.env, options.envMode) } : {}),
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
                severity: processEventSeverity('error', null),
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
        const reason =
            result.outcome ??
            (isTimedOut(completion) ? 'timeout' : result.signal !== undefined ? 'signal' : error ? 'error' : 'exit');
        this.emitProcessEvent('process.exited', {
            command: result.command,
            args: result.args,
            exitCode: result.exitCode,
            ...(result.signal !== undefined ? { signal: result.signal } : {}),
            durationMs: result.durationMs,
            reason,
            timestamp: new Date().toISOString(),
            severity: processEventSeverity(reason, result.exitCode),
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
                severity: processEventSeverity(this.killedWith !== undefined ? 'signal' : 'exit', exitCode),
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
    groupOwned: boolean;
}): ExecaOptions {
    const mode = opts.forceBuffered ? 'buffered' : (opts.outputPolicy?.mode ?? 'buffered');
    const streamToTerminal =
        mode === 'stream' &&
        (opts.outputPolicy?.mode === 'stream' ? (opts.outputPolicy.isTTY ?? process.stdout.isTTY ?? isatty(1)) : false);

    return {
        reject: opts.rejectOnError,
        stdin: 'ignore',
        stripFinalNewline: true,
        ...(mode === 'pipe'
            ? { stdout: 'pipe', stderr: 'pipe' }
            : streamToTerminal
              ? { stdout: ['inherit', 'pipe'] as const, stderr: ['inherit', 'pipe'] as const }
              : { all: true }),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...(opts.timeout !== undefined && !opts.groupOwned ? { timeout: opts.timeout } : {}),
        ...(opts.maxOutput !== undefined ? { maxBuffer: opts.maxOutput } : {}),
        // Group-owned runs make the child lead a distinct process group so negative-pid
        // signaling can reach the whole tree; termination itself runs through the
        // executor's own escalation path (deadline and abort feed one sequence).
        // Platforms without Unix group semantics cancel the direct child via execa.
        ...(opts.groupOwned ? { detached: true } : {}),
        ...(opts.signal !== undefined && !opts.groupOwned ? { cancelSignal: opts.signal } : {}),
    };
}

// ── Deadline and process-group containment ───────────────────────────

/**
 * Largest delay accepted by native timers; anything larger would overflow onto an
 * immediate timer, so deadline/grace values beyond it are rejected before spawn.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Default grace between the owned group SIGTERM and the SIGKILL escalation. */
const DEFAULT_KILL_GRACE_MS = 5000;

/** Poll cadence while waiting for an owned process group to empty. */
const GROUP_POLL_INTERVAL_MS = 25;

/** Bounded patience after group SIGKILL before giving up on unkillable (D-state) members. */
const GROUP_KILL_PATIENCE_MS = 2000;

/**
 * Resolve the effective deadline: omitted inherits the executor default (which may itself
 * be unlimited), explicit `null` is unlimited and overrides any finite default, and a
 * finite value must be a positive integer within the native timer range. Invalid values
 * are rejected before spawn — never clamped and never overflowed onto a timer.
 */
function resolveDeadline(
    optionTimeout: number | null | undefined,
    defaultTimeout: number | null | undefined,
): number | null | undefined {
    if (optionTimeout === null) return null;
    const candidate = optionTimeout === undefined ? defaultTimeout : optionTimeout;
    if (candidate === undefined || candidate === null) return candidate;
    if (!Number.isInteger(candidate) || candidate <= 0 || candidate > MAX_TIMEOUT_MS) {
        throw new TypeError(
            `Process timeout must be a positive integer within the native timer range (1-${MAX_TIMEOUT_MS} ms), got ${String(candidate)}`,
        );
    }
    return candidate;
}

/**
 * Resolve the SIGTERM→SIGKILL escalation grace: omitted uses {@link DEFAULT_KILL_GRACE_MS},
 * `0` escalates immediately, and anything outside the native timer range is rejected.
 */
function resolveKillGraceMs(optionGraceMs: number | undefined): number {
    if (optionGraceMs === undefined) return DEFAULT_KILL_GRACE_MS;
    if (!Number.isInteger(optionGraceMs) || optionGraceMs < 0 || optionGraceMs > MAX_TIMEOUT_MS) {
        throw new TypeError(
            `Process killGraceMs must be a non-negative integer within the native timer range (0-${MAX_TIMEOUT_MS} ms), got ${String(optionGraceMs)}`,
        );
    }
    return optionGraceMs;
}

/** Whether any member of the owned process group is still alive (signal 0 probe on `-pid`). */
function groupExists(pid: number): boolean {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        // EPERM means the group exists but is not signallable from here.
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/** Signal the owned process group; `false` when the group is already gone (ESRCH). */
function signalGroup(pid: number, signal: NodeJS.Signals | number): boolean {
    try {
        process.kill(-pid, signal);
        return true;
    } catch {
        return false;
    }
}

async function waitForGroupExit(pid: number, budgetMs: number): Promise<boolean> {
    const giveUpAt = Date.now() + budgetMs;
    while (groupExists(pid)) {
        if (Date.now() >= giveUpAt) return false;
        await new Promise<void>((resolve) => setTimeout(resolve, GROUP_POLL_INTERVAL_MS));
    }
    return true;
}

/**
 * The one termination sequence for an owned Unix process group: group SIGTERM, wait the
 * grace for the whole group to empty, then group SIGKILL and a bounded settle wait.
 * Group liveness — not direct-child exit — decides completion, so escalation is never
 * cancelled because the leader exited first while descendants retain pipes or locks.
 * Resolves `true` only when a group signal was actually delivered.
 */
async function reapProcessGroup(pid: number, graceMs: number): Promise<boolean> {
    if (!signalGroup(pid, 'SIGTERM')) return false;
    if (await waitForGroupExit(pid, graceMs)) return true;
    signalGroup(pid, 'SIGKILL');
    await waitForGroupExit(pid, GROUP_KILL_PATIENCE_MS);
    return true;
}

/** Handle for the executor-owned termination of one spawned process group. */
interface ProcessGroupOwnership {
    /**
     * Settle the run's termination: resolve the outcome delivered by the executor's own
     * path (deadline `timeout` or external `cancelled`) after the escalation completed, or
     * reap surviving owned descendants after a natural leader exit (outcome stays `exit`).
     * Call exactly once, after the execa promise has settled; bounded, never hangs.
     */
    finish(): Promise<ProcessOutcome | undefined>;
    /** Release the deadline timer and abort listener once the execa promise has settled. */
    stop(): void;
}

/**
 * Own one detached child's process group on Unix. A deadline timer and the caller's abort
 * signal both feed a single termination path — group SIGTERM, grace, SIGKILL — and after a
 * natural leader exit surviving owned descendants are reaped with the same sequence, so
 * completion cannot leak group members holding inherited pipes or database write locks.
 */
function ownProcessGroupLifecycle(ownership: {
    pid: number;
    deadlineMs: number | undefined;
    signal: AbortSignal | undefined;
    graceMs: number;
}): ProcessGroupOwnership {
    const { pid, graceMs } = ownership;
    let trigger: 'timeout' | 'cancelled' | undefined;
    let termination: Promise<boolean> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const initiate = (reason: 'timeout' | 'cancelled'): void => {
        if (trigger !== undefined) return;
        trigger = reason;
        termination = reapProcessGroup(pid, graceMs);
    };

    if (ownership.deadlineMs !== undefined) {
        timer = setTimeout(() => initiate('timeout'), ownership.deadlineMs);
    }
    const onAbort = (): void => initiate('cancelled');
    if (ownership.signal !== undefined) {
        if (ownership.signal.aborted) onAbort();
        else ownership.signal.addEventListener('abort', onAbort, { once: true });
    }

    return {
        finish: async () => {
            if (trigger === undefined) {
                // Natural completion: reap stragglers (no-op when the group is already empty).
                await reapProcessGroup(pid, graceMs);
                return undefined;
            }
            // An undeliverable trigger (group already gone — the child finished first)
            // yields undefined so the outcome falls back to the natural classification.
            return (await termination) ? trigger : undefined;
        },
        stop: () => {
            if (timer !== undefined) clearTimeout(timer);
            ownership.signal?.removeEventListener('abort', onAbort);
        },
    };
}

/** Classify an execa rejection on paths where the executor did not own the termination. */
function classifyFailedCompletion(error: {
    timedOut?: boolean;
    isCanceled?: boolean;
    isTerminated?: boolean;
    signalDescription?: string;
    signal?: string;
}): ProcessOutcome {
    if (error.timedOut === true) return 'timeout';
    if (error.isCanceled === true) return 'cancelled';
    if (error.isTerminated === true || error.signalDescription !== undefined || error.signal !== undefined) {
        return 'signal';
    }
    return 'error';
}

function observeOutput(
    stream: NodeJS.ReadableStream | null | undefined,
    name: ProcessOutputChunk['stream'],
    observer: ProcessOptions['onOutput'],
): void {
    if (!stream || !observer) return;
    // Task 0086 R13: one decoder per stream with `stream: true` keeps multi-byte
    // UTF-8 sequences intact across chunk boundaries; a fresh decoder per chunk
    // would split them into U+FFFD replacement characters.
    const decoder = new TextDecoder();
    const emit = (chunk: string) => {
        try {
            observer({ stream: name, chunk, timestamp: new Date().toISOString() });
        } catch {
            // Observability is best-effort and must never interrupt child I/O.
        }
    };
    stream.on('data', (chunk: string | Uint8Array) => {
        emit(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    });
    stream.on('end', () => {
        const tail = decoder.decode();
        if (tail.length > 0) emit(tail);
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
