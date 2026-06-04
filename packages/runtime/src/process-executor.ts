import { isatty } from 'node:tty';
import { type Options as ExecaOptions, execa } from 'execa';

/** Controls how stdout/stderr is captured: buffered in memory or streamed to the caller's terminal. */
export type OutputPolicy = { mode: 'buffered' } | { mode: 'stream'; isTTY?: boolean };

/** Shared configuration for a process executor (default timeout, output buffering, output policy). */
export interface ProcessExecutorConfig {
    defaultTimeout?: number;
    defaultMaxOutput?: number;
    output?: OutputPolicy;
}

/** Options for spawning a child process. */
export interface ProcessOptions {
    command: string;
    args?: string[];
    cwd?: string;
    /**
     * Environment forwarded verbatim to the child process. Caller-controlled — when launching an
     * untrusted command, pass an explicit allowlist rather than the parent's full environment, so
     * inherited secrets are not leaked into the subprocess.
     */
    env?: Record<string, string>;
    timeout?: number;
    /** Maximum output buffer size in bytes (maps to execa `maxBuffer`). */
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

/** Asynchronous process executor — spawns a child process and returns a {@link ProcessResult}. */
export interface ProcessExecutor {
    run(options: ProcessOptions): Promise<ProcessResult>;
}

/** Synchronous process executor for Bun — blocks until the child process exits. */
export interface SyncProcessExecutor {
    runSync(options: Omit<ProcessOptions, 'timeout'>): ProcessResult;
}

/** Options for spawning a long-running pipe process with streaming I/O. */
export interface PipeProcessOptions {
    command: string;
    args?: string[];
    cwd?: string;
    /** Forwarded verbatim to the child — pass an allowlist for untrusted commands (see {@link ProcessOptions.env}). */
    env?: Record<string, string>;
}

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

/** Factory for spawning {@link PipeProcess} instances. */
export interface PipeProcessSpawner {
    spawn(options: PipeProcessOptions): PipeProcess;
}

/** {@link ProcessExecutor} backed by the `execa` library for Node.js. */
export class NodeProcessExecutor implements ProcessExecutor {
    constructor(private readonly config: ProcessExecutorConfig = {}) {}

    async run(options: ProcessOptions): Promise<ProcessResult> {
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

        try {
            const result = await execa(options.command, args, execaOptions);
            return {
                command: options.command,
                args,
                exitCode: result.exitCode ?? null,
                stdout: asString(result.stdout),
                stderr: asString(result.stderr),
                ...(result.signalDescription !== undefined ? { signal: result.signalDescription } : {}),
                durationMs: result.durationMs,
            };
        } catch (error) {
            if (options.rejectOnError) throw error;
            const failed = error as {
                exitCode?: number;
                stdout?: string | string[] | Uint8Array;
                stderr?: string | string[] | Uint8Array;
                signalDescription?: string;
                durationMs?: number;
            };
            return {
                command: options.command,
                args,
                exitCode: failed.exitCode ?? null,
                stdout: asString(failed.stdout),
                stderr: asString(failed.stderr),
                ...(failed.signalDescription !== undefined ? { signal: failed.signalDescription } : {}),
                durationMs: failed.durationMs ?? 0,
            };
        }
    }
}

/** {@link SyncProcessExecutor} backed by `Bun.spawnSync`. */
export class BunSyncProcessExecutor implements SyncProcessExecutor {
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

/** {@link PipeProcessSpawner} backed by `Bun.spawn`. */
export class BunPipeProcessSpawner implements PipeProcessSpawner {
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

type BunSubprocess = ReturnType<typeof Bun.spawn>;
type ProcessSignal = Parameters<BunSubprocess['kill']>[0];
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
