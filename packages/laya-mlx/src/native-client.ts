/**
 * In-process MLX client over `@johnhenry/laya` (`mlx-native` core).
 * Runs the same Laya checkpoint on Apple Silicon Metal through libmlxc FFI —
 * no Python interpreter, no child process. Exposes the same `ask()` shape as
 * {@link LayaWorkerClient} so the driver maps answers identically for both cores.
 */

import { DecisionBackendError, DecisionConfigError } from '@gobing-ai/ts-ai-runner';
import type { LayaAgent, Questions } from '@johnhenry/laya';
import {
    DEFAULT_LAYA_MODEL_ID,
    hasNonFiniteValues,
    type LayaWorkerResult,
    validateHostPrerequisites,
    type WorkerQuestion,
} from './worker-client';

/** Loads a checkpoint into a ready agent; the seam the tests substitute. */
export type LayaNativeLoader = (target: string, opts: Record<string, unknown>) => Promise<LayaAgent>;

/** Configuration for {@link LayaNativeClient}. */
export interface LayaNativeClientOptions {
    /** Hugging Face model id. Default: `convaiinnovations/laya-multilingual`. */
    modelId?: string;
    /** Local checkpoint directory (e.g. a fine-tuned model); wins over `modelId`. */
    modelPath?: string;
    /** Checkpoint revision pinned for resolution. */
    revision?: string;
    /**
     * Not supported natively: `@johnhenry/laya` resolves the hub cache from the
     * process environment only. Set → construction fails rather than being silently ignored.
     */
    cacheDir?: string;
    /** Weight precision. `bfloat16` is not supported by the native backend. Default: `'float16'`. */
    dtype?: 'float32' | 'float16' | 'bfloat16';
    /** Questions per forward pass. Default: `16`. */
    batchSize?: number;
    /** Injected environment record — this package never reads the ambient environment (ADR-011). */
    env?: Record<string, string | undefined>;
    platform?: string;
    arch?: string;
    /** Injected loader (tests). Default: dynamic import of `@johnhenry/laya`'s `load`. */
    loader?: LayaNativeLoader;
}

const defaultLoader: LayaNativeLoader = async (target, opts) => {
    // Dynamic import keeps libmlxc/koffi out of the module graph when the python core is used.
    const { load } = await import('@johnhenry/laya');
    return load(target, opts);
};

/**
 * In-process MLX client over `@johnhenry/laya`: same wire shape and `ask()`
 * contract as {@link LayaWorkerClient}, backed by libmlxc instead of a Python
 * worker. Construction validates the host and the options the native backend
 * cannot honor; the checkpoint is loaded lazily on the first `warm()`/`ask()`.
 */
export class LayaNativeClient {
    private agent: LayaAgent | null = null;
    private loading: Promise<LayaAgent> | null = null;
    private chain: Promise<unknown> = Promise.resolve();
    private disposed = false;
    private readonly target: string;
    private readonly loadOptions: Record<string, unknown>;
    private readonly loader: LayaNativeLoader;

    constructor(options: LayaNativeClientOptions = {}) {
        validateHostPrerequisites(options.platform, options.arch);
        const cacheDir = options.cacheDir ?? options.env?.LAYA_CACHE_DIR;
        if (cacheDir !== undefined) {
            throw new DecisionConfigError(
                "laya core 'mlx-native' cannot honor cacheDir/LAYA_CACHE_DIR; set HF_HUB_CACHE for the process or use core 'mlx-python'",
                'LAYA_CACHE_DIR',
            );
        }
        if (options.dtype === 'bfloat16') {
            throw new DecisionConfigError(
                "laya core 'mlx-native' supports dtype 'float16' or 'float32', not 'bfloat16'",
                'LAYA_DTYPE',
            );
        }
        this.target =
            options.modelPath ??
            options.env?.LAYA_MODEL_PATH ??
            options.modelId ??
            options.env?.LAYA_MODEL_ID ??
            DEFAULT_LAYA_MODEL_ID;
        this.loadOptions = {
            backend: 'mlx',
            dtype: options.dtype === 'float32' ? 'f32' : 'f16',
            batchSize: options.batchSize ?? 16,
            ...(options.revision !== undefined ? { revision: options.revision } : {}),
            ...(options.env?.HF_TOKEN ? { token: options.env.HF_TOKEN } : {}),
            // The temperature-clamping notice would otherwise land on the host's console.
            warn: () => {},
        };
        this.loader = options.loader ?? defaultLoader;
    }

    /** Checkpoint target actually loaded (model path or hub id). */
    get model(): string {
        return this.target;
    }

    /** Eagerly load the weights; `auto` core resolution uses this to probe native availability. */
    async warm(): Promise<void> {
        await this.ensureAgent();
    }

    /** Ask one batch of worker-format questions; serialized like the python worker. */
    ask(state: string, questions: Record<string, WorkerQuestion>): Promise<LayaWorkerResult> {
        const run = this.chain.then(() => this.dispatch(state, questions));
        this.chain = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    /** Release Metal buffers; safe to call repeatedly. */
    dispose(): void {
        this.disposed = true;
        this.agent?.dispose();
        this.agent = null;
    }

    private async dispatch(state: string, questions: Record<string, WorkerQuestion>): Promise<LayaWorkerResult> {
        const agent = await this.ensureAgent();
        let result: LayaWorkerResult;
        try {
            // WorkerQuestion is the laya-mlx wire shape, which @johnhenry/laya ports 1:1.
            result = (await agent.predict(state, questions as unknown as Questions)) as unknown as LayaWorkerResult;
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            throw new DecisionBackendError(`laya native inference failed: ${message}`, undefined, { cause });
        }
        if (hasNonFiniteValues(result.answers)) {
            throw new DecisionBackendError(
                "laya native returned non-finite model outputs; retry with dtype='float32'",
                undefined,
            );
        }
        return result;
    }

    private ensureAgent(): Promise<LayaAgent> {
        if (this.disposed) {
            return Promise.reject(new DecisionBackendError('laya native client has been disposed', undefined));
        }
        if (this.agent) return Promise.resolve(this.agent);
        this.loading ??= this.loader(this.target, this.loadOptions).then(
            (agent) => {
                this.loading = null;
                if (this.disposed) {
                    agent.dispose();
                    throw new DecisionBackendError('laya native client has been disposed', undefined);
                }
                this.agent = agent;
                return agent;
            },
            (cause: unknown) => {
                this.loading = null;
                const message = cause instanceof Error ? cause.message : String(cause);
                throw new DecisionConfigError(
                    `laya core 'mlx-native' failed to load '${this.target}': ${message}`,
                    'LAYA_CORE',
                    { cause },
                );
            },
        );
        return this.loading;
    }
}
