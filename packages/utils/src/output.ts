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

export function echo(message: string, target: WriteTarget = defaultStdoutTarget ?? processStream('stdout')): void {
    writeLine(message, target);
}

export function echoError(message: string, target: WriteTarget = defaultStderrTarget ?? processStream('stderr')): void {
    writeLine(message, target);
}

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

export interface BufferTarget extends WriteTarget {
    readonly chunks: string[];
    text(): string;
    clear(): void;
}

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
