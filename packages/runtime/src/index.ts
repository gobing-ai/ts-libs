export * from './config';
export * from './context';
export { createRuntimeContextFromFactory } from './context';
export { D1NotConfiguredError, DbModuleNotInstalledError } from './db-errors';
export type { FileStat, FileSystem } from './file-system';
export { createCfFileSystem } from './file-system-cf';
export { createNodeFileSystem, findProjectRoot } from './file-system-node';
export {
    atomicWriteFile,
    atomicWriteJson,
    createLogStream,
    ensureDirForFile,
    readJsonFile,
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
    ProcessOutcome,
    ProcessOutputChunk,
    ProcessResult,
    ProcessSignal,
    TracerPort,
} from './process-executor';
export { NodeProcessExecutor, ProcessExecutor } from './process-executor';
export type {
    InMemoryProcessRegistryOptions,
    ProcessExecution,
    ProcessExecutionBegin,
    ProcessExecutionComplete,
    ProcessExecutionFilter,
    ProcessExecutionSource,
    ProcessExecutionStatus,
    ProcessRegistry,
    ProcessRegistryEvent,
} from './process-registry';
export { createInMemoryProcessRegistry, InMemoryProcessRegistry } from './process-registry';
export { cloudflareWorkersFactory } from './runtime-cf';
export type { RuntimeFactory } from './runtime-factory';
export { _resetNodeFileSystem, nodeBunFactory } from './runtime-node-bun';
export type { RuntimePaths } from './runtime-paths';
export { ambientRuntimePaths } from './runtime-paths';
export * from './schema-validation';
export * from './types';

// ── Deprecated re-exports (backward compatibility) ──────────────────────

/** Sync executor shape (task 0087 R7) — satisfied by NodeSyncProcessExecutor (preferred) and the deprecated BunSyncProcessExecutor. */
export type { SyncProcessExecutor } from './process-executor';
export { BunPipeProcessSpawner, BunSyncProcessExecutor, NodeSyncProcessExecutor } from './process-executor';

/**
 * @deprecated Use {@link ProcessExecutor.runStreaming} instead.
 */
export type PipeProcessSpawner = InstanceType<typeof import('./process-executor').BunPipeProcessSpawner>;
