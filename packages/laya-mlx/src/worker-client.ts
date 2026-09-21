/**
 * Process-lifecycle client for the laya JSON-lines worker (task 0076).
 *
 * Spawns `worker/laya_worker.py` through ts-runtime's `ProcessExecutor.runStreaming`
 * (ADR-011/ADR-014 — the only sanctioned spawn seam), awaits the startup handshake
 * before the first request, correlates responses by id, and enforces two independent
 * budgets: `startupTimeoutMs` for the one-time weight load, `requestTimeoutMs` for a
 * single forward pass. The worker is started lazily on the first ask and held for the
 * client's lifetime; a worker that dies rejects every in-flight call and the next ask
 * starts a fresh process — never a silent mid-ask restart. Only documented env keys
 * reach the child, so the injected-env contract (ADR-011) holds across the process
 * boundary. Protocol reference: docs/design/laya-local-decision-backend.md.
 */
import {
    DecisionAuthError,
    DecisionBackendError,
    DecisionConfigError,
    DecisionConnectionError,
    type DecisionError,
    DecisionRequestError,
    DecisionTimeoutError,
} from '@gobing-ai/ts-ai-runner';
import { joinPath, nodeBunFactory, type PipeProcess, type ProcessExecutor } from '@gobing-ai/ts-runtime';

/** Environment keys this package may pass to the child process — the full allowlist. */
const FORWARDED_ENV_KEYS = ['LAYA_MODEL_ID', 'LAYA_MODEL_PATH', 'LAYA_CACHE_DIR', 'LAYA_PYTHON', 'HF_TOKEN'] as const;

/** How many trailing stderr bytes to keep for exit-failure messages. */
const STDERR_TAIL_LIMIT = 2000;

/** Grace window for the exit event once stdout closes, so pending calls reject with the exit-informed error. */
const STREAM_CLOSE_GRACE_MS = 250;

/** Configuration options for {@link LayaWorkerClient}. */
export interface LayaWorkerClientOptions {
    /** Interpreter that carries `laya-mlx`. Default: `'python3'`. */
    pythonPath?: string;
    /** Runtime module the worker imports. Default: `'laya_mlx'`. */
    module?: string;
    /** Worker script path. Default: `worker/laya_worker.py` in this package. */
    workerScript?: string;
    /** Working directory for the spawn. Default: this package root. */
    cwd?: string;
    /** Hugging Face model id. Default: worker-side (the runtime's own default). */
    modelId?: string;
    /** Local checkpoint directory; wins over `modelId`. */
    modelPath?: string;
    /** Checkpoint revision pinned for resolution. */
    revision?: string;
    /** Artifact cache root, exported as `HF_HUB_CACHE` inside the worker. */
    cacheDir?: string;
    /** Weight precision. Default: `'float16'`. */
    dtype?: 'float32' | 'float16' | 'bfloat16';
    /** Questions per forward pass. Default: `16`. */
    batchSize?: number;
    /** Budget for the startup handshake, which covers the one-time weight load. Default: `120_000`. */
    startupTimeoutMs?: number;
    /** Budget for one request once the worker is ready. Default: `30_000`. */
    requestTimeoutMs?: number;
    /** Injected environment record — this package never reads the ambient environment (ADR-011). */
    env?: Record<string, string | undefined>;
    /** Platform name for prerequisite validation. Default: `process.platform`. */
    platform?: string;
    /** Architecture name for prerequisite validation. Default: `process.arch`. */
    arch?: string;
}

/**
 * Project the injected environment onto the child allowlist. Everything absent from
 * `FORWARDED_ENV_KEYS` is dropped, so the parent environment is never inherited
 * wholesale and the child gets exactly the documented keys that are set.
 */
export function resolveForwardedEnv(env: Record<string, string | undefined> | undefined): Record<string, string> {
    const forwarded: Record<string, string> = {};
    if (!env) return forwarded;
    for (const key of FORWARDED_ENV_KEYS) {
        const value = env[key];
        if (value !== undefined) forwarded[key] = value;
    }
    return forwarded;
}

/** Worker-level question — the reference format `predict` consumes. Neutral-shape mapping lands with the driver facade. */
export interface WorkerQuestion {
    type: 'choice' | 'score' | 'noul';
    instructions: string;
    [key: string]: unknown;
}

/** The runtime's own `predict` payload, passed through unaltered. */
export interface LayaWorkerResult {
    model: string;
    answers: Record<string, unknown>;
    usage?: Record<string, unknown>;
}

/** Startup handshake emitted once before any request is served. */
interface WorkerHandshake {
    ready: boolean;
    model?: string;
    revision?: string | null;
    maxLen?: number;
    error?: { kind: string; message: string };
}

/** One parsed stdout line; open-ended, so known fields are typed and the rest indexed. */
interface WorkerLine {
    id?: string | number;
    ok?: boolean;
    result?: LayaWorkerResult;
    error?: { kind: string; message: string };
}

/**
 * Validate host platform prerequisites for `@gobing-ai/ts-laya-mlx`.
 * Throws {@link DecisionConfigError} if the platform is not Apple Silicon macOS.
 */
export function validateHostPrerequisites(platform: string = process.platform, arch: string = process.arch): void {
    if (platform !== 'darwin' || arch !== 'arm64') {
        throw new DecisionConfigError(
            `laya-mlx requires macOS on Apple Silicon (darwin arm64); current platform is '${platform} ${arch}'`,
            'PLATFORM',
        );
    }
}

function hasNonFiniteValues(obj: unknown): boolean {
    if (typeof obj === 'number') {
        return !Number.isFinite(obj);
    }
    if (obj !== null && typeof obj === 'object') {
        for (const val of Object.values(obj as Record<string, unknown>)) {
            if (hasNonFiniteValues(val)) return true;
        }
    }
    return false;
}

/**
 * Map worker-reported error kinds and messages onto the decision taxonomy (design: Errors table, task 0077).
 */
export function translateWorkerError(kind: string | undefined, message: string): DecisionError {
    const lower = message.toLowerCase();
    // Credential/auth failures during artifact resolution (0077 R6)
    if (
        lower.includes('401') ||
        lower.includes('unauthorized') ||
        lower.includes('403') ||
        lower.includes('forbidden') ||
        lower.includes('gated repo') ||
        lower.includes('hf_token') ||
        lower.includes('invalid credentials')
    ) {
        const status = lower.includes('403') || lower.includes('forbidden') ? 403 : 401;
        return new DecisionAuthError(`laya artifact resolution failed: ${message}`, status);
    }
    // Transport/connection failures during artifact resolution (0077 R6)
    if (
        lower.includes('connectionerror') ||
        lower.includes('connection refused') ||
        lower.includes('name resolution') ||
        lower.includes('nameresolutionerror') ||
        lower.includes('network is unreachable') ||
        lower.includes('could not connect') ||
        lower.includes('transport')
    ) {
        return new DecisionConnectionError(`laya artifact resolution failed: ${message}`);
    }
    // Missing runtime (0077 R2)
    if (lower.includes('no module named') || lower.includes('laya_mlx') || lower.includes('laya-mlx')) {
        return new DecisionConfigError(
            `laya-mlx runtime is not importable: ${message}; install with 'pip install laya-mlx'`,
            'LAYA_PYTHON',
        );
    }
    // Non-finite output (0077 R5)
    if (
        lower.includes('non-finite') ||
        lower.includes('floatingpointerror') ||
        lower.includes('nan') ||
        lower.includes('infinity')
    ) {
        return new DecisionBackendError(`laya worker non-finite output: ${message}`, undefined);
    }
    switch (kind) {
        case 'config':
            return new DecisionConfigError(`laya worker rejected its configuration: ${message}`, 'laya-worker');
        case 'request':
            return new DecisionRequestError(`laya worker rejected the request: ${message}`, undefined, message);
        default:
            return new DecisionBackendError(`laya worker backend failure: ${message}`, undefined);
    }
}

/** Map a worker-reported error kind onto the decision taxonomy (design: Errors table). */
function toWorkerError(kind: string | undefined, message: string): DecisionError {
    return translateWorkerError(kind, message);
}

interface PendingEntry {
    resolve: (result: LayaWorkerResult) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * A started worker process plus its line pump, pending-request map, handshake
 * race, and exit watcher. The pump owns the stdout stream exclusively: the first
 * line settles the handshake, every later line dispatches by id.
 */
class WorkerHandle {
    readonly proc: PipeProcess;
    readonly handshake: Promise<WorkerHandshake>;
    private readonly requestTimeoutMs: number;
    private readonly pending = new Map<string, PendingEntry>();
    private nextRequestId = 1;
    private alive = true;
    private stderrTail = '';
    private handshakeSettled = false;
    private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
    private handshakeResolve: ((handshake: WorkerHandshake) => void) | null = null;
    private handshakeReject: ((error: Error) => void) | null = null;
    private streamCloseTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(proc: PipeProcess, requestTimeoutMs: number, startupTimeoutMs: number) {
        this.proc = proc;
        this.requestTimeoutMs = requestTimeoutMs;
        this.handshake = new Promise<WorkerHandshake>((resolve, reject) => {
            this.handshakeResolve = resolve;
            this.handshakeReject = reject;
        });
        this.handshakeTimer = setTimeout(() => {
            this.failHandshake(
                new DecisionTimeoutError(
                    `laya worker did not emit its handshake within startupTimeoutMs (${startupTimeoutMs})`,
                    startupTimeoutMs,
                ),
            );
        }, startupTimeoutMs);
        if (proc.stdout !== null) this.pump(proc.stdout);
        if (proc.stderr !== null) this.collectStderr(proc.stderr);
        void proc.exited.then((code) => {
            this.alive = false;
            this.failHandshake(this.exitError(code));
            this.failAll(this.exitError(code));
        });
    }

    /** Reject everything in flight; the map clear makes repeated calls harmless. */
    failAll(error: Error): void {
        this.alive = false;
        for (const entry of this.pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        this.pending.clear();
    }

    /** Close stdin for a graceful EOF exit. */
    end(): void {
        try {
            this.proc.endStdin();
        } catch {
            // Already dead — the exit watcher owns failure propagation from here.
        }
    }

    /** Terminate a worker that must not keep running (startup failure). */
    kill(): void {
        try {
            this.proc.kill();
        } catch {
            // Already dead — the exit watcher owns failure propagation from here.
        }
    }

    get isAlive(): boolean {
        return this.alive;
    }

    /**
     * Register a pending entry under the request timeout and return its correlation
     * id. Registered before the write so the exit watcher covers the send window.
     */
    armRequest(resolve: (result: LayaWorkerResult) => void, reject: (error: Error) => void): string {
        const id = String(this.nextRequestId++);
        const requestTimeoutMs = this.requestTimeoutMs;
        const timer = setTimeout(() => {
            // Reject this request only; the stream keeps running and the late
            // response is dropped by id when it arrives (no queue corruption).
            this.pending.delete(id);
            reject(
                new DecisionTimeoutError(
                    `laya worker request ${id} exceeded requestTimeoutMs (${requestTimeoutMs})`,
                    requestTimeoutMs,
                ),
            );
        }, requestTimeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        return id;
    }

    private exitError(code: number | null): DecisionError {
        const tail = this.stderrTail.length > 0 ? `: ${this.stderrTail}` : '';
        const raw = `${this.stderrTail} (code ${code ?? 'unknown'})`;
        if (raw.includes('No module named') || raw.includes('laya_mlx')) {
            return new DecisionConfigError(
                `laya-mlx runtime is not importable: ${raw}; install with 'pip install laya-mlx'`,
                'LAYA_PYTHON',
            );
        }
        return new DecisionBackendError(
            `laya worker exited unexpectedly (code ${code ?? 'unknown'})${tail}`,
            undefined,
        );
    }

    private failHandshake(error: Error): void {
        if (this.handshakeSettled) return;
        this.handshakeSettled = true;
        if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
        this.handshakeReject?.(error);
    }

    /** Read stdout as UTF-8 JSON Lines; first line settles the handshake, the rest dispatch by id. */
    private pump(stream: ReadableStream<Uint8Array>): void {
        const decoder = new TextDecoder();
        let buffer = '';
        void (async () => {
            for await (const chunk of stream) {
                buffer += decoder.decode(chunk, { stream: true });
                let newlineAt = buffer.indexOf('\n');
                while (newlineAt !== -1) {
                    this.onLine(buffer.slice(0, newlineAt));
                    buffer = buffer.slice(newlineAt + 1);
                    newlineAt = buffer.indexOf('\n');
                }
            }
            buffer += decoder.decode();
            if (buffer.trim().length > 0) this.onLine(buffer);
            this.onStreamClosed();
        })().catch(() => {
            this.failAll(new DecisionBackendError('laya worker output stream failed', undefined));
        });
    }

    /**
     * Stdout closed: a dead worker's pipes drain before its exit event resolves, so
     * defer to the exit watcher — pending calls must reject with the exit-informed
     * error (exit code + stderr tail), not a generic stream close. The grace timer
     * bounds the wait for a worker that closed its stream but kept running; those
     * calls fall back to the close rejection instead of hanging to their timeouts.
     */
    private onStreamClosed(): void {
        this.streamCloseTimer = setTimeout(() => {
            this.streamCloseTimer = null;
            this.failAll(new DecisionBackendError('laya worker closed its output stream', undefined));
        }, STREAM_CLOSE_GRACE_MS);
        void this.proc.exited.then((code) => {
            if (this.streamCloseTimer !== null) {
                clearTimeout(this.streamCloseTimer);
                this.streamCloseTimer = null;
            }
            this.failAll(this.exitError(code));
        });
    }

    private onLine(line: string): void {
        if (!this.handshakeSettled) {
            this.settleHandshake(line);
            return;
        }
        let parsed: WorkerLine;
        try {
            parsed = JSON.parse(line) as WorkerLine;
        } catch {
            // Stream framing is broken — no pending request can trust what follows.
            this.failAll(
                new DecisionBackendError(`laya worker emitted an unparseable line: ${line.slice(0, 200)}`, undefined),
            );
            this.kill();
            return;
        }
        if (parsed.id === undefined) return; // stray line without correlation — dropped by design
        const entry = this.pending.get(String(parsed.id));
        if (entry === undefined) return; // late response for an already-rejected request
        this.pending.delete(String(parsed.id));
        clearTimeout(entry.timer);
        if (parsed.ok === true && parsed.result !== undefined) {
            if (hasNonFiniteValues(parsed.result.answers)) {
                entry.reject(
                    new DecisionBackendError(
                        "laya worker returned non-finite model outputs; retry with dtype='float32'",
                        undefined,
                    ),
                );
                return;
            }
            entry.resolve(parsed.result);
            return;
        }
        if (parsed.ok === false) {
            entry.reject(toWorkerError(parsed.error?.kind, parsed.error?.message ?? 'unknown worker error'));
            return;
        }
        entry.reject(
            new DecisionBackendError(
                `laya worker sent a malformed response for request ${String(parsed.id)}`,
                undefined,
            ),
        );
    }

    /** First stdout line: validate the handshake envelope and settle the startup race. */
    private settleHandshake(line: string): void {
        if (this.handshakeSettled) return; // the timeout or the exit watcher won the race
        this.handshakeSettled = true;
        if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
        let handshake: WorkerHandshake;
        try {
            handshake = JSON.parse(line) as WorkerHandshake;
        } catch {
            this.handshakeReject?.(
                new DecisionBackendError(`laya worker handshake was not JSON: ${line.slice(0, 200)}`, undefined),
            );
            return;
        }
        if (handshake.ready === true) {
            this.handshakeResolve?.(handshake);
            return;
        }
        this.handshakeReject?.(
            toWorkerError(
                handshake.error?.kind ?? 'config',
                handshake.error?.message ?? 'worker reported it was not ready',
            ),
        );
    }

    /** Drain stderr so a chatty worker cannot block, keeping a tail for exit diagnostics. */
    private collectStderr(stream: ReadableStream<Uint8Array>): void {
        const decoder = new TextDecoder();
        void (async () => {
            for await (const chunk of stream) {
                this.stderrTail = `${this.stderrTail}${decoder.decode(chunk, { stream: true })}`.slice(
                    -STDERR_TAIL_LIMIT,
                );
            }
        })().catch(() => {
            // Stderr diagnostics are best-effort only.
        });
    }
}

/**
 * TypeScript half of the laya process bridge: start the Python worker lazily,
 * hold it warm for the client's lifetime, and serve serialized asks with
 * id-correlated, timeout-bounded responses.
 */
export class LayaWorkerClient {
    private readonly pythonPath: string;
    private readonly args: string[];
    private readonly cwd: string;
    private readonly startupTimeoutMs: number;
    private readonly requestTimeoutMs: number;
    private readonly forwardedEnv: Record<string, string>;
    private readonly executor: ProcessExecutor;
    private worker: WorkerHandle | null = null;
    private chain: Promise<unknown> = Promise.resolve();
    private disposed = false;

    constructor(
        options: LayaWorkerClientOptions = {},
        executor: ProcessExecutor = nodeBunFactory.createProcessExecutor(),
    ) {
        validateHostPrerequisites(options.platform, options.arch);
        const packageRoot = joinPath(import.meta.dir, '..');
        this.pythonPath = options.pythonPath ?? options.env?.LAYA_PYTHON ?? 'python3';
        this.cwd = options.cwd ?? packageRoot;
        this.startupTimeoutMs = options.startupTimeoutMs ?? 120_000;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
        this.forwardedEnv = resolveForwardedEnv(options.env);
        this.executor = executor;
        this.args = [options.workerScript ?? joinPath(packageRoot, 'worker', 'laya_worker.py')];
        this.args.push('--module', options.module ?? 'laya_mlx');
        const resolvedModelPath = options.modelPath ?? options.env?.LAYA_MODEL_PATH;
        const resolvedCacheDir = options.cacheDir ?? options.env?.LAYA_CACHE_DIR;
        const resolvedModelId = options.modelId ?? options.env?.LAYA_MODEL_ID ?? 'convaiinnovations/laya-multilingual';

        if (resolvedModelPath !== undefined) {
            this.args.push('--model-path', resolvedModelPath);
        } else {
            this.args.push('--model', resolvedModelId);
        }
        if (options.revision !== undefined) this.args.push('--revision', options.revision);
        this.args.push('--dtype', options.dtype ?? 'float16');
        this.args.push('--batch-size', String(options.batchSize ?? 16));
        if (resolvedCacheDir !== undefined) this.args.push('--cache-dir', resolvedCacheDir);
    }

    /**
     * Ask one batch of worker-format questions. Requests are serialized — the
     * worker serves one request at a time and batching happens inside a single
     * request — and the worker spawns lazily on the first call, so the weight
     * load is paid once per client.
     */
    ask(state: string, questions: Record<string, WorkerQuestion>): Promise<LayaWorkerResult> {
        const run = this.chain.then(() => this.dispatch(state, questions));
        this.chain = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    /** Close the worker; safe to call repeatedly. In-flight calls reject through the exit watcher. */
    dispose(): void {
        this.disposed = true;
        const worker = this.worker;
        this.worker = null;
        worker?.end();
    }

    private async dispatch(state: string, questions: Record<string, WorkerQuestion>): Promise<LayaWorkerResult> {
        if (this.disposed) throw new DecisionBackendError('laya worker client has been disposed', undefined);
        const worker = await this.ensureWorker();
        return new Promise<LayaWorkerResult>((resolve, reject) => {
            const id = worker.armRequest(resolve, reject);
            try {
                worker.proc.writeStdin(`${JSON.stringify({ id, state, questions })}\n`);
            } catch (cause) {
                reject(new DecisionBackendError('laya worker rejected the request line', undefined, { cause }));
                return;
            }
            if (!worker.isAlive) {
                // The exit watcher raced the write; fail now instead of at the timeout.
                worker.failAll(
                    new DecisionBackendError('laya worker exited before the request could be sent', undefined),
                );
            }
        });
    }

    private async ensureWorker(): Promise<WorkerHandle> {
        if (this.worker?.isAlive) return this.worker;
        this.worker = null;
        const worker = this.spawn();
        try {
            await worker.handshake;
        } catch (error) {
            // Startup failed: nothing is in flight, so terminate and surface the
            // error. The next ask starts fresh rather than reusing a dead handle.
            worker.kill();
            throw error;
        }
        if (this.disposed) {
            // dispose() raced the startup handshake — the worker must not outlive
            // a disposed client.
            worker.kill();
            throw new DecisionBackendError('laya worker client has been disposed', undefined);
        }
        this.worker = worker;
        return worker;
    }

    private spawn(): WorkerHandle {
        let proc: PipeProcess;
        try {
            proc = this.executor.runStreaming({
                command: this.pythonPath,
                args: this.args,
                env: this.forwardedEnv,
                envMode: 'replace',
                label: 'laya-worker',
                cwd: this.cwd,
            });
        } catch (cause) {
            throw new DecisionConfigError(
                `Python interpreter '${this.pythonPath}' is missing or not executable; install Python 3.10+ (e.g. via 'brew install python@3.11') or set LAYA_PYTHON`,
                'LAYA_PYTHON',
                { cause },
            );
        }
        const handle = new WorkerHandle(proc, this.requestTimeoutMs, this.startupTimeoutMs);
        void proc.exited.then(() => {
            if (this.worker === handle) {
                this.worker = null;
            }
        });
        return handle;
    }
}
