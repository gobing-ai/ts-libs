export interface WriteTarget {
    write(chunk: string): unknown;
}

let defaultStdoutTarget: WriteTarget = process.stdout;
let defaultStderrTarget: WriteTarget = process.stderr;

function writeLine(message: string, target: WriteTarget): void {
    target.write(`${message}\n`);
}

export function echo(message: string, target: WriteTarget = defaultStdoutTarget): void {
    writeLine(message, target);
}

export function echoError(message: string, target: WriteTarget = defaultStderrTarget): void {
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
