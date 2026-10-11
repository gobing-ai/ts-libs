/**
 * @gobing-ai/ts-laya-mlx — Local Laya decision backend driving the vendored MLX runtime.
 * Implements the {@link DecisionDriver} interface for `@gobing-ai/ts-ai-runner` on one of two MLX cores:
 * a JSON-lines Python worker (`mlx-python`, default) or in-process `@johnhenry/laya` (`mlx-native`).
 */

export {
    createLayaClient,
    createLayaDriver,
    type LayaClient,
    type LayaCore,
    type LayaDriverOptions,
    resolveLayaCore,
} from './driver';
export { LayaNativeClient, type LayaNativeClientOptions, type LayaNativeLoader } from './native-client';
export {
    DEFAULT_LAYA_MODEL_ID,
    LayaWorkerClient,
    type LayaWorkerClientOptions,
    type LayaWorkerResult,
    translateWorkerError,
    validateHostPrerequisites,
    type WorkerQuestion,
} from './worker-client';
