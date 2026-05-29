import type { JobQueue } from '../job-queue/types';
import { getLogger, type Logger } from '../logger';
import type {
    AsyncEnqueuedDetail,
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
    private readonly asyncHandlerIds = new WeakMap<TEvents[keyof TEvents], string>();
    private readonly jobQueue: JobQueue | null;
    private readonly lifecycleBus: EventBus<BusLifecycleEvents> | null;
    private nextAsyncHandlerId = 0;

    constructor(opts?: {
        jobQueue?: JobQueue;
        lifecycleBus?: EventBus<BusLifecycleEvents>;
    }) {
        this.jobQueue = opts?.jobQueue ?? null;
        this.lifecycleBus = opts?.lifecycleBus ?? null;
    }

    on<K extends keyof TEvents>(event: K, handler: TEvents[K], opts?: SubscribeOptions): void {
        if (opts?.async) {
            this.registerAsync(event, handler);
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
        }
    }

    removeAllListeners<K extends keyof TEvents>(event?: K): void {
        if (event !== undefined) {
            this.syncHandlers.delete(event);
            this.asyncHandlers.delete(event);
        } else {
            this.syncHandlers.clear();
            this.asyncHandlers.clear();
        }
    }

    async emit<K extends keyof TEvents>(event: K, ...args: Parameters<TEvents[K]>): Promise<void> {
        const eventName = String(event);
        const startMs = performance.now();
        let syncCount = 0;
        let asyncCount = 0;
        let errors = 0;

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

        this.publishEmitDone({ event: eventName, syncCount, asyncCount, emitDurationMs: durationMs, errors, detail });

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

    private registerAsync<K extends keyof TEvents>(event: K, handler: TEvents[K]): void {
        let set = this.asyncHandlers.get(event);
        if (!set) {
            set = new Set();
            this.asyncHandlers.set(event, set);
        }
        set.add(handler);
    }

    private getAsyncHandlerId(handler: TEvents[keyof TEvents]): string {
        const existing = this.asyncHandlerIds.get(handler);
        if (existing) return existing;

        const id = `handler-${++this.nextAsyncHandlerId}`;
        this.asyncHandlerIds.set(handler, id);
        return id;
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
                void this.lifecycleBus.emit('bus.emit.noop', { event });
            } catch {
                // Swallow.
            }
        }
    }

    private publishHandlerError(event: string, mode: 'sync' | 'async', error: string): void {
        if (this.lifecycleBus) {
            const detail: HandlerErrorDetail = { event, mode, error };
            try {
                void this.lifecycleBus.emit('bus.handler.error', detail);
            } catch {
                // Swallow.
            }
        }
    }

    private publishAsyncEnqueued(event: string, jobId: string, handlerCount: number): void {
        if (this.lifecycleBus) {
            const detail: AsyncEnqueuedDetail = { event, jobId, handlerCount };
            try {
                void this.lifecycleBus.emit('bus.handler.async.enqueued', detail);
            } catch {
                // Swallow.
            }
        }
    }
}
