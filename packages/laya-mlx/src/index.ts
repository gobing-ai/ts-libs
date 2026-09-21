/**
 * @gobing-ai/ts-laya-mlx — Local Laya decision backend driving the vendored MLX runtime.
 * Implements the {@link DecisionDriver} interface for `@gobing-ai/ts-ai-runner` over a JSON-lines process bridge.
 */

export { createLayaDriver, type LayaDriverOptions } from './driver';
export {
    LayaWorkerClient,
    type LayaWorkerClientOptions,
    type LayaWorkerResult,
    translateWorkerError,
    validateHostPrerequisites,
    type WorkerQuestion,
} from './worker-client';
