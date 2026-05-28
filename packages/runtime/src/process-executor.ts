import { isatty } from 'node:tty';
import { type Options as ExecaOptions, execa } from 'execa';

export type OutputPolicy = { mode: 'buffered' } | { mode: 'stream'; isTTY?: boolean };

export interface ProcessExecutorConfig {
    defaultTimeout?: number;
    defaultMaxOutput?: number;
    output?: OutputPolicy;
}

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

export interface ProcessResult {
    command: string;
    args: string[];
    exitCode: number | null;
    stdout: string;
    stderr: string;
    signal?: string;
    durationMs: number;
}

export interface ProcessExecutor {
    run(options: ProcessOptions): Promise<ProcessResult>;
}

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
