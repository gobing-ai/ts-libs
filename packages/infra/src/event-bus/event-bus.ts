import type { JobHandler, JobQueue } from '../job-queue/types';
import { getLogger, type Logger } from '../logger';
import { getEventbusEmitsTotal, getEventbusErrorsTotal } from '../telemetry/metrics';
import type {
    AsyncEnqueuedDetail,
    AsyncEventJobPayload,
    BusLifecycleEvents,
    EmitDoneDetail,
    EventMap,
    HandlerErrorDetail,
    SubscribeOptions,
} from './types';

let _busLogger: Logger | undefined;
function busLogger(): Logger {
    if (!_busLogger) _busLogger = getLogger('event-bus');
    return _busLogger;
}

/**
 * Type-safe event bus supporting both synchronous (in-process) and
 * asynchronous handlers with optional job-queue enqueue instrumentation.
 */
export class EventBus<TEvents extends EventMap> {
    private readonly syncHandlers = new Map<keyof TEvents, Set<TEvents[keyof TEvents]>>();
    private readonly asyncHandlers = new Map<keyof TEvents, Set<TEvents[keyof TEvents]>>();
    private readonly asyncHandlerIds = new Map<TEvents[keyof TEvents], string>();
    private readonly asyncHandlersById = new Map<string, TEvents[keyof TEvents]>();
    private readonly jobQueue: JobQueue | null;
    private readonly lifecycleBus: EventBus<BusLifecycleEvents> | null;
    private readonly logger: Logger | undefined;
    private nextAsyncHandlerId = 0;
    constructor(opts?: {
        jobQueue?: JobQueue;
        lifecycleBus?: EventBus<BusLifecycleEvents>;
        logger?: Logger;
    }) {
        this.jobQueue = opts?.jobQueue ?? null;
        this.lifecycleBus = opts?.lifecycleBus ?? null;
        this.logger = opts?.logger;
    }

    on<K extends keyof TEvents>(event: K, handler: TEvents[K], opts?: SubscribeOptions): void {
        if (opts?.async) {
            this.registerAsync(event, handler, opts.name);
        } else {
            this.registerSync(event, handler);
        }
    }

    once<K extends keyof TEvents>(event: K, handler: TEvents[K], opts?: SubscribeOptions): void {
        const wrapped = ((...args: Parameters<TEvents[K]>) => {
            this.off(event, wrapped as TEvents[K]);
            handler(...args);
        }) as TEvents[K];

        this.on(event, wrapped, opts);
    }

    off<K extends keyof TEvents>(event: K, handler: TEvents[K]): void {
        const syncSet = this.syncHandlers.get(event);
        if (syncSet) {
            syncSet.delete(handler);
            if (syncSet.size === 0) {
                this.syncHandlers.delete(event);
            }
        }

        const asyncSet = this.asyncHandlers.get(event);
        if (asyncSet) {
            asyncSet.delete(handler);
            if (asyncSet.size === 0) {
                this.asyncHandlers.delete(event);
            }
            this.releaseAsyncIdIfUnsubscribed(handler);
        }
    }

    removeAllListeners<K extends keyof TEvents>(event?: K): void {
        if (event !== undefined) {
            this.syncHandlers.delete(event);
            const asyncSet = this.asyncHandlers.get(event);
            this.asyncHandlers.delete(event);
            if (asyncSet) {
                for (const handler of asyncSet) this.releaseAsyncIdIfUnsubscribed(handler);
            }
        } else {
            this.syncHandlers.clear();
            this.asyncHandlers.clear();
            this.asyncHandlerIds.clear();
            this.asyncHandlersById.clear();
        }
    }

    async emit<K extends keyof TEvents>(event: K, ...args: Parameters<TEvents[K]>): Promise<void> {
        const eventName = String(event);
        const startMs = performance.now();
        let syncCount = 0;
        let asyncCount = 0;
        let errors = 0;

        this.logger?.debug('event.emit', {
            event: eventName,
            syncHandlers: this.syncHandlers.get(event)?.size ?? 0,
            asyncHandlers: this.asyncHandlers.get(event)?.size ?? 0,
        });

        const syncSet = this.syncHandlers.get(event);
        if (syncSet) {
            syncCount = syncSet.size;
            for (const handler of syncSet) {
                try {
                    handler(...args);
                } catch (error) {
                    errors++;
                    const message = error instanceof Error ? error.message : String(error);
                    busLogger().error('sync handler threw', { event: eventName, error: message });
                    this.publishHandlerError(eventName, 'sync', message);
                }
            }
        }

        const asyncSet = this.asyncHandlers.get(event);
        if (asyncSet && asyncSet.size > 0) {
            const handlers = [...asyncSet];
            asyncCount = handlers.length;

            for (const handler of handlers) {
                if (this.jobQueue) {
                    try {
                        const jobId = await this.jobQueue.enqueue(eventName, {
                            event: eventName,
                            args,
                            handlerId: this.getAsyncHandlerId(handler),
                        });
                        busLogger().debug('async job enqueued', { event: eventName, jobId, handlerCount: 1 });
                        this.publishAsyncEnqueued(eventName, jobId, 1);
                        continue;
                    } catch (error) {
                        errors++;
                        const message = error instanceof Error ? error.message : String(error);
                        busLogger().error('async enqueue failed', { event: eventName, error: message });
                        this.publishHandlerError(eventName, 'async', message);
                        continue;
                    }
                } else {
                    busLogger().warn('async handlers registered but no JobQueue injected', {
                        event: eventName,
                    });
                }

                try {
                    await Promise.resolve().then(() => handler(...args));
                } catch (error) {
                    errors++;
                    const message = error instanceof Error ? error.message : String(error);
                    busLogger().error('async handler threw', { event: eventName, error: message });
                    this.publishHandlerError(eventName, 'async', message);
                }
            }
        }

        const durationMs = performance.now() - startMs;
        const detail = args.length === 1 ? args[0] : args.length > 1 ? args : undefined;

        // Metrics are emitted inline here; traces (span attributes + events) are attached
        // by attachTelemetryObserver in default-observers.ts — see that file for the trace layer.
        getEventbusEmitsTotal().add(1, { event: eventName });
        if (errors > 0) getEventbusErrorsTotal().add(errors, { event: eventName });

        this.publishEmitDone({
            event: eventName,
            syncCount,
            asyncCount,
            emitDurationMs: durationMs,
            errors,
            detail,
            severity: errors > 0 ? 'warning' : 'info',
        });

        if (syncCount === 0 && asyncCount === 0) {
            busLogger().debug('emit with zero handlers', { event: eventName });
            this.publishEmitNoop(eventName);
        }
    }

    listenerCount<K extends keyof TEvents>(event: K, mode?: 'sync' | 'async'): number {
        const sync = mode !== 'async' ? (this.syncHandlers.get(event)?.size ?? 0) : 0;
        const async = mode !== 'sync' ? (this.asyncHandlers.get(event)?.size ?? 0) : 0;
        return sync + async;
    }

    eventNames(): string[] {
        const names = new Set<string>();
        for (const key of this.syncHandlers.keys()) names.add(String(key));
        for (const key of this.asyncHandlers.keys()) names.add(String(key));
        return [...names];
    }

    private registerSync<K extends keyof TEvents>(event: K, handler: TEvents[K]): void {
        let set = this.syncHandlers.get(event);
        if (!set) {
            set = new Set();
            this.syncHandlers.set(event, set);
        }
        set.add(handler);
    }

    private registerAsync<K extends keyof TEvents>(event: K, handler: TEvents[K], name?: string): void {
        let set = this.asyncHandlers.get(event);
        if (!set) {
            set = new Set();
            this.asyncHandlers.set(event, set);
        }
        set.add(handler);

        if (!this.asyncHandlerIds.has(handler)) {
            const id = name ?? `handler-${++this.nextAsyncHandlerId}`;
            if (this.asyncHandlersById.has(id)) {
                throw new Error(`Duplicate async handler name: "${id}"`);
            }
            this.asyncHandlerIds.set(handler, id);
            this.asyncHandlersById.set(id, handler);
        }
    }

    private getAsyncHandlerId(handler: TEvents[keyof TEvents]): string {
        const existing = this.asyncHandlerIds.get(handler);
        if (existing) return existing;

        const id = `handler-${++this.nextAsyncHandlerId}`;
        this.asyncHandlerIds.set(handler, id);
        this.asyncHandlersById.set(id, handler);
        return id;
    }

    /** Drop a handler's id mappings once it is subscribed to no event at all. */
    private releaseAsyncIdIfUnsubscribed(handler: TEvents[keyof TEvents]): void {
        for (const set of this.asyncHandlers.values()) {
            if (set.has(handler)) return;
        }
        const id = this.asyncHandlerIds.get(handler);
        if (id !== undefined) {
            this.asyncHandlerIds.delete(handler);
            this.asyncHandlersById.delete(id);
        }
    }

    /**
     * Bridge for queue-backed async dispatch: returns a `JobHandler` to
     * register on a queue consumer for each async event's job type. It
     * dispatches the enqueued `{ event, args, handlerId }` payload back to the
     * matching async handler on THIS bus instance.
     *
     * Use named async subscriptions (`SubscribeOptions.name`) when jobs may be
     * consumed after a process restart — anonymous handler ids are
     * process-local and not stable across restarts.
     *
     * @throws when the payload references an unknown handler id, so the job
     * lands in the queue's retry/fail path instead of vanishing silently.
     */
    createJobHandler(): JobHandler<AsyncEventJobPayload> {
        return async (job) => {
            const { event, args, handlerId } = job.payload;
            const handler = this.asyncHandlersById.get(handlerId);
            if (!handler) {
                throw new Error(`No async handler registered for id "${handlerId}" (event "${event}")`);
            }
            // Serialization round-trips args through unknown[]; the handler type
            // is `TEvents[K] & ((...args: unknown[]) => void)` — both satisfy the
            // same constraint. Use unknown => unknown to bridge the covariance gap.
            type AnyHandler = (...args: unknown[]) => unknown;
            await (handler as unknown as AnyHandler)(...args);
        };
    }

    private publishEmitDone(detail: EmitDoneDetail): void {
        if (this.lifecycleBus) {
            try {
                void this.lifecycleBus.emit('bus.emit.done', detail);
            } catch {
                // Lifecycle bus failures must never affect the primary bus.
            }
        }
    }

    private publishEmitNoop(event: string): void {
        if (this.lifecycleBus) {
            try {
                void this.lifecycleBus.emit('bus.emit.noop', { event, severity: 'info' });
            } catch {
                // Swallow.
            }
        }
    }

    private publishHandlerError(event: string, mode: 'sync' | 'async', error: string): void {
        if (this.lifecycleBus) {
            const detail: HandlerErrorDetail = { event, mode, error, severity: 'error' };
            try {
                void this.lifecycleBus.emit('bus.handler.error', detail);
            } catch {
                // Swallow.
            }
        }
    }

    private publishAsyncEnqueued(event: string, jobId: string, handlerCount: number): void {
        if (this.lifecycleBus) {
            const detail: AsyncEnqueuedDetail = { event, jobId, handlerCount, severity: 'info' };
            try {
                void this.lifecycleBus.emit('bus.handler.async.enqueued', detail);
            } catch {
                // Swallow.
            }
        }
    }
}
