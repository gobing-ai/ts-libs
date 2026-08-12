// API Client
export {
    APIClient,
    type APIClientConfig,
    APIError,
    type RawHttpResponse,
    type RawRequestOptions,
    type RequestOptions,
} from './api-client';

// Event Bus
export {
    type AsyncEventJobPayload,
    attachDefaultObservers,
    attachFileObserver,
    attachLogObserver,
    attachTelemetryObserver,
    type BusLifecycleEvents,
    createLifecycleBus,
    EventBus,
    type EventMap,
    type FileObserverWriter,
    type SubscribeOptions,
} from './event-bus/index';

// Events (infrastructure-level event maps)
export type {
    ApiClientEvents,
    ApiRequestErrorDetail,
    DbConnectionErrorDetail,
    DbEvents,
    EventSeverity,
    InfraEvents,
    QueueConsumerStartedDetail,
    QueueConsumerStoppedDetail,
    QueueEvents,
    QueueJobCompletedDetail,
    QueueJobEnqueuedDetail,
    QueueJobFailedDetail,
    QueueJobRef,
    QueueJobRetryingDetail,
    SchedulerEvents,
    SchedulerJobExecutedDetail,
    WithEventSeverity,
} from './events';

export type {
    EnqueueOptions,
    Job,
    JobHandler,
    JobQueue,
    QueueConsumer,
    QueueConsumerConfig,
    QueueStats,
} from './job-queue/index';
// Logger
export {
    getLogger,
    type InitLoggerOptions,
    initializeLogger,
    type Logger,
    type LogLevel,
    setLoggerMuted,
} from './logger';

// Scheduler
export {
    ActionRegistry,
    type CreateDefaultRegistryOptions,
    createDefaultRegistry,
    HealthPingAction,
    type HealthPingWriter,
    initScheduler,
    LogAction,
    NoopSchedulerAdapter,
    QueueStatsAction,
    type QueueStatsDaoProvider,
    type ScheduledAction,
    type SchedulerAction,
    type SchedulerAdapter,
    toScheduledAction,
    wrapScheduledHandler,
} from './scheduler/index';

// Telemetry
export {
    addSpanAttributes,
    addSpanEvent,
    extractSqlOperation,
    getActiveSpan,
    getEventbusEmitsTotal,
    getEventbusErrorsTotal,
    getHttpClientRequestDuration,
    getHttpClientRequestErrors,
    getHttpClientRequestTotal,
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
} from './telemetry/index';
