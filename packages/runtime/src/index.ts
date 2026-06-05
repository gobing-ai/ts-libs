export * from './config';
export * from './context';
export { createRuntimeContextFromFactory } from './context';
export type { FileStat, FileSystem } from './file-system';
export { createCfFileSystem } from './file-system-cf';
export { createNodeFileSystem, findProjectRoot } from './file-system-node';
export {
    atomicWriteFile,
    atomicWriteJson,
    CloudflareFileSystem,
    createLogStream,
    ensureDirForFile,
    ensureDirForFileSync,
    type FileSystem as LegacyFileSystem,
    getFs,
    getProjectRoot,
    NodeFileSystem,
    NodeSyncFileSystem,
    readJsonFile,
    resolveProjectPath,
    type SyncFileSystem,
    setFileSystem,
    walkDir,
    writeJsonFile,
} from './fs';
export * from './path';
export { _resetRuntimeFactory, isCloudflareWorkerRuntime, loadRuntimeFactory } from './platform';
export type {
    OutputPolicy,
    PipeProcess,
    PipeProcessOptions,
    ProcessEventDetail,
    ProcessEventSink,
    ProcessEvents,
    ProcessExecutorConfig,
    ProcessExitReason,
    ProcessOptions,
    ProcessResult,
    ProcessSignal,
    TracerPort,
} from './process-executor';
export { ProcessExecutor } from './process-executor';
export { cloudflareWorkersFactory } from './runtime-cf';
export type { RuntimeFactory } from './runtime-factory';
export { _resetNodeFileSystem, nodeBunFactory } from './runtime-node-bun';
export * from './schema-validation';
export * from './types';

// ── Deprecated re-exports (backward compatibility) ──────────────────────

export { BunPipeProcessSpawner, BunSyncProcessExecutor, NodeProcessExecutor } from './process-executor';

/**
 * @deprecated Use {@link ProcessExecutor} directly for async execution.
 * Use `Bun.spawnSync` or `child_process.spawnSync` for sync.
 */
export type SyncProcessExecutor = InstanceType<typeof import('./process-executor').BunSyncProcessExecutor>;

/**
 * @deprecated Use {@link ProcessExecutor.runStreaming} instead.
 */
export type PipeProcessSpawner = InstanceType<typeof import('./process-executor').BunPipeProcessSpawner>;
