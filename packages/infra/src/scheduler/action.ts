/**
 * Named scheduler actions and a registry, plus built-in actions.
 *
 * Opt-in by design: `createDefaultRegistry` only auto-registers the side-effect-
 * free `LogAction`. Actions with side effects (`QueueStatsAction` needs a DAO
 * provider, `HealthPingAction` needs a file writer) are included only when their
 * dependency is supplied — downstream code decides what to enable.
 */

import type { EventBus } from '../event-bus/event-bus';
import type { QueueEvents } from '../events';
import type { QueueStats } from '../job-queue/types';
import { getLogger } from '../logger';
import type { ScheduledAction } from './types';

const logger = getLogger('scheduler.action');

/** Lazily provides a DAO with `getStats()`, deferred to execution time. */
export type QueueStatsDaoProvider = () => Promise<{ getStats(): Promise<QueueStats> }>;

/**
 * Minimal writer for {@link HealthPingAction}. ADR-011: ts-infra does not touch
 * `node:fs`; the caller injects a writer (e.g. ts-runtime `FileSystem`).
 */
export interface HealthPingWriter {
    /** Write `content` to `path`, replacing any existing file. */
    writeFile(path: string, content: string): void | Promise<void>;
}

/**
 * A named action invokable by the scheduler. Registered in an
 * {@link ActionRegistry} and resolved by name; `execute()` matches the
 * adapter's no-arg {@link ScheduledAction} signature.
 */
export interface SchedulerAction {
    /** Unique action name registered in the registry. */
    readonly name: string;
    /** Execute the action. */
    execute(): Promise<void>;
}

/** Bridge a {@link SchedulerAction} to a plain {@link ScheduledAction} for adapter registration. */
export function toScheduledAction(action: SchedulerAction): ScheduledAction {
    return () => action.execute();
}

/**
 * Registry of named {@link SchedulerAction} instances, resolved at scheduler
 * startup. Duplicate names are rejected.
 */
export class ActionRegistry {
    private readonly map = new Map<string, SchedulerAction>();

    constructor(actions?: SchedulerAction[]) {
        if (actions) {
            for (const action of actions) this.register(action);
        }
    }

    /** Register an action. @throws if the name is already registered. */
    register(action: SchedulerAction): void {
        if (this.map.has(action.name)) {
            throw new Error(`Duplicate scheduler action name: "${action.name}"`);
        }
        this.map.set(action.name, action);
    }

    /** Look up an action by name. */
    get(name: string): SchedulerAction | undefined {
        return this.map.get(name);
    }

    /** Whether an action with the given name exists. */
    has(name: string): boolean {
        return this.map.has(name);
    }

    /** All registered action names. */
    names(): string[] {
        return [...this.map.keys()];
    }
}

/** Logs a structured info message on every invocation. Registered as `"log"`. */
export class LogAction implements SchedulerAction {
    readonly name: string;

    constructor(name = 'log') {
        this.name = name;
    }

    async execute(): Promise<void> {
        logger.info('Scheduled action executed', { action: this.name });
    }
}

/**
 * Queries the queue DAO for stats and logs them; emits `queue.stats` when a
 * system bus is provided. Registered as `"queue-stats"`.
 */
export class QueueStatsAction implements SchedulerAction {
    readonly name = 'queue-stats';

    constructor(
        private readonly daoProvider: QueueStatsDaoProvider,
        private readonly systemBus: EventBus<QueueEvents> | null = null,
    ) {}

    async execute(): Promise<void> {
        const dao = await this.daoProvider();
        const stats = await dao.getStats();
        logger.info('Queue stats snapshot', { action: this.name, ...stats });
        await this.systemBus?.emit('queue.stats', { ...stats, severity: 'info' });
    }
}

/**
 * Writes a timestamped heartbeat file on every invocation. Registered as
 * `"health-ping"`. File I/O is delegated to an injected {@link HealthPingWriter}.
 */
export class HealthPingAction implements SchedulerAction {
    readonly name = 'health-ping';

    constructor(
        private readonly writer: HealthPingWriter,
        private readonly filePath = 'data/scheduler-heartbeat.json',
    ) {}

    async execute(): Promise<void> {
        const content = JSON.stringify({
            lastRun: new Date().toISOString(),
            jobName: this.name,
        });
        await this.writer.writeFile(this.filePath, content);
    }
}

/** Options for {@link createDefaultRegistry}. */
export interface CreateDefaultRegistryOptions {
    /** DAO provider for `QueueStatsAction`. Omit to exclude that action. */
    queueStatsDaoProvider?: QueueStatsDaoProvider;
    /** Writer for `HealthPingAction`. Omit to exclude that action. */
    healthPingWriter?: HealthPingWriter;
    /** File path for `HealthPingAction`. Default `"data/scheduler-heartbeat.json"`. */
    healthPingPath?: string;
    /** System bus forwarded to `QueueStatsAction` for `queue.stats` events. */
    systemBus?: EventBus<QueueEvents> | null;
}

/**
 * Create an {@link ActionRegistry} with the built-in actions. Only `LogAction`
 * is always present (no side effects); `QueueStatsAction` and `HealthPingAction`
 * are included only when their dependency (`queueStatsDaoProvider` /
 * `healthPingWriter`) is supplied — so nothing with side effects is auto-wired.
 */
export function createDefaultRegistry(options: CreateDefaultRegistryOptions = {}): ActionRegistry {
    const actions: SchedulerAction[] = [new LogAction()];
    if (options.queueStatsDaoProvider) {
        actions.push(new QueueStatsAction(options.queueStatsDaoProvider, options.systemBus ?? null));
    }
    if (options.healthPingWriter) {
        actions.push(new HealthPingAction(options.healthPingWriter, options.healthPingPath));
    }
    return new ActionRegistry(actions);
}

export type { ScheduledAction } from './types';
