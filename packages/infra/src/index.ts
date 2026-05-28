// API Client
export { APIClient, type APIClientConfig, APIError, type RequestOptions } from './api-client.js';

// Event Bus
export { EventBus, type EventMap, type EventObserver, type SubscribeOptions } from './event-bus/index.js';

// Events
export type { AppEvents, AppInternalEvents } from './events/index.js';
export { createSystemBus } from './events/index.js';

// Job Queue
export type {
    EnqueueOptions,
    Job,
    JobHandler,
    JobQueue,
    QueueConsumer,
    QueueConsumerConfig,
    QueueStats,
} from './job-queue/index.js';

// Logger
export { getLogger, initializeLogger, type Logger, type LogLevel, setLoggerMuted } from './logger.js';

// Scheduler
export {
    CloudflareSchedulerAdapter,
    getSchedulerAdapter,
    initScheduler,
    NodeSchedulerAdapter,
    NoopSchedulerAdapter,
    type ScheduledAction,
    type SchedulerAdapter,
    setSchedulerAdapter,
} from './scheduler/index.js';

// Telemetry
export {
    addSpanAttributes,
    addSpanEvent,
    extractSqlOperation,
    getActiveSpan,
    getDbOperationDuration,
    getDbOperationErrors,
    getDbOperationTotal,
    getEventbusEmitsTotal,
    getEventbusErrorsTotal,
    getHttpClientRequestDuration,
    getHttpClientRequestErrors,
    getHttpClientRequestTotal,
    getHttpServerRequestDuration,
    getHttpServerRequestErrors,
    getHttpServerRequestTotal,
    getQueueJobCompletedTotal,
    getQueueJobEnqueuedTotal,
    getQueueJobFailedTotal,
    getQueueJobProcessingDuration,
    getSchedulerJobDuration,
    getSchedulerJobExecutedTotal,
    getSchedulerJobFailedTotal,
    getTelemetryConfig,
    getTracer,
    initMetrics,
    initTelemetry,
    isTelemetryEnabled,
    sanitizeSql,
    shutdownMetrics,
    shutdownTelemetry,
    type TelemetryConfig,
    type TelemetryConfigPartial,
    traceAsync,
    traceSync,
    withSpan,
} from './telemetry/index.js';
