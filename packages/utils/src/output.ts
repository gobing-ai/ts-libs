/** Minimal write sink: anything that accepts a string chunk. */
export interface WriteTarget {
    write(chunk: string): unknown;
}

// Resolved lazily, not at module load: reading `process.std*` eagerly would throw on import in
// runtimes without `process` (e.g. Cloudflare Workers). `undefined` means "fall back to process".
let defaultStdoutTarget: WriteTarget | undefined;
let defaultStderrTarget: WriteTarget | undefined;

function processStream(name: 'stdout' | 'stderr'): WriteTarget {
    const proc = (globalThis as { process?: { stdout?: WriteTarget; stderr?: WriteTarget } }).process;
    const stream = proc?.[name];
    if (stream === undefined) {
        throw new Error(`No ${name} target available: set one via setDefaultOutputTargets or pass an explicit target`);
    }
    return stream;
}

function writeLine(message: string, target: WriteTarget): void {
    target.write(`${message}\n`);
}

/** Write a line to a target, defaulting to stdout. */
export function echo(message: string, target: WriteTarget = defaultStdoutTarget ?? processStream('stdout')): void {
    writeLine(message, target);
}

/** Write a line to a target, defaulting to stderr. */
export function echoError(message: string, target: WriteTarget = defaultStderrTarget ?? processStream('stderr')): void {
    writeLine(message, target);
}

/**
 * Override the default stdout/stderr targets.
 *
 * Returns a rollback function that restores the previous targets.
 */
export function setDefaultOutputTargets(opts: { stdout?: WriteTarget; stderr?: WriteTarget }): () => void {
    const prevStdout = defaultStdoutTarget;
    const prevStderr = defaultStderrTarget;
    if (opts.stdout) defaultStdoutTarget = opts.stdout;
    if (opts.stderr) defaultStderrTarget = opts.stderr;
    return () => {
        defaultStdoutTarget = prevStdout;
        defaultStderrTarget = prevStderr;
    };
}

/** Terminates the current process with `code`. Anything matching `(code?: number) => never`. */
export type ExitTarget = (code?: number) => never;

// Resolved lazily, not at module load: reading `process.exit` eagerly would throw on import in
// runtimes without `process` (e.g. Cloudflare Workers). `undefined` means "fall back to process".
let defaultExitTarget: ExitTarget | undefined;

function processExit(): ExitTarget {
    const proc = (globalThis as { process?: { exit?: ExitTarget } }).process;
    const exit = proc?.exit;
    if (exit === undefined) {
        throw new Error('No exit target available: set one via setDefaultExitTarget or pass an explicit target');
    }
    return exit;
}

/**
 * Terminate the process with the given exit code — the single sanctioned seam
 * for `process.exit` in the workspace (enforced by the `no-direct-process-exit`
 * spur rule). Defaults to `0`. Pass or set an {@link ExitTarget} to intercept
 * in tests or non-`process` runtimes.
 */
export function exitProcess(code = 0, target: ExitTarget = defaultExitTarget ?? processExit()): never {
    return target(code);
}

/**
 * Override the default exit target.
 *
 * Returns a rollback function that restores the previous target.
 */
export function setDefaultExitTarget(target: ExitTarget | undefined): () => void {
    const prev = defaultExitTarget;
    defaultExitTarget = target;
    return () => {
        defaultExitTarget = prev;
    };
}

/** In-memory `WriteTarget` that records all chunks for later retrieval. */
export interface BufferTarget extends WriteTarget {
    readonly chunks: string[];
    text(): string;
    clear(): void;
}

/** Create an in-memory {@link BufferTarget} for capturing output during tests or tooling. */
export function createBufferTarget(): BufferTarget {
    const chunks: string[] = [];
    return {
        chunks,
        write(chunk: string) {
            chunks.push(String(chunk));
            return true;
        },
        text() {
            return chunks.join('');
        },
        clear() {
            chunks.length = 0;
        },
    };
}
