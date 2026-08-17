/**
 * Node/Bun convenience bootstrap for `@gobing-ai/ts-infra`.
 *
 * Composes the portable `runApplication` with runtime-specific wiring:
 * - YAML config loading via `@gobing-ai/ts-runtime`
 * - Application-specific config validation with caller-provided validator
 * - File log sink via `node:fs`
 * - Bun SQLite DB adapter creation from config
 * - Optional Node OTel exporter initialization
 * - Optional Node scheduler adapter
 *
 * This subpath may import runtime-specific adapters. The portable bootstrap
 * subpath (`@gobing-ai/ts-infra/application`) must not.
 *
 * @module application-node
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { createDbAdapter, type DbAdapter } from '@gobing-ai/ts-db';
import { createNodeFileSystem, interpolateTree, parseYamlObject } from '@gobing-ai/ts-runtime';

import { runApplication } from './application/index';
import { dbPlugin } from './application/plugins/builtins';
import type { Plugin } from './application/plugins/types';
import type {
    ApplicationBootstrapOptions,
    ApplicationConfigLoader,
    ApplicationConfigValidator,
    ApplicationRuntime,
    ApplicationStopReason,
    ConfigValidationResult,
    DbAdapterLike,
    EventMap,
    EventsOptions,
    InfraEvents,
    LoggingOptions,
    SchedulerOptions,
    TelemetryOptions,
} from './application/types';
import { NodeSchedulerAdapter } from './scheduler-node';
import { initNodeTelemetry, shutdownNodeTelemetry } from './telemetry/otel-node';

// ── Errors ────────────────────────────────────────────────────────────────

/** Error thrown when application config validation fails. Includes file path and section name. */
export class ConfigValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigValidationError';
    }
}

// ── Config validation helper ──────────────────────────────────────────────

/**
 * Validate a raw config section using the caller-provided validator.
 * Supports structural `safeParse`, `validate()`, `parse()`, and bare function forms.
 */
function validateAppConfig<TAppConfig>(
    validator: ApplicationConfigValidator<TAppConfig>,
    raw: unknown,
    section: string,
    filePath: string | undefined,
): TAppConfig {
    if (typeof validator === 'object' && 'safeParse' in validator) {
        const result: ConfigValidationResult<TAppConfig> = validator.safeParse(raw);
        if (!result.success) {
            const details = result.errors?.map((e) => `${e.path}: ${e.message}`).join('; ') ?? 'unknown error';
            throw new ConfigValidationError(
                `Application config validation failed in section "${section}"` +
                    (filePath ? ` (file: ${filePath})` : '') +
                    `: ${details}`,
            );
        }
        return result.data as TAppConfig;
    }

    if (typeof validator === 'function') {
        return (validator as (raw: unknown) => TAppConfig)(raw);
    }

    if (typeof validator === 'object' && 'validate' in validator) {
        return validator.validate(raw);
    }

    if (typeof validator === 'object' && 'parse' in validator) {
        return validator.parse(raw);
    }

    throw new ConfigValidationError(`Unsupported validator shape for section "${section}"`);
}

// ── File sink helper ──────────────────────────────────────────────────────

function createFileSink(filePath: string): (line: string) => void {
    return (line: string) => {
        try {
            mkdirSync(dirname(filePath), { recursive: true });
            appendFileSync(filePath, line);
        } catch {
            // Best-effort — don't crash on log write failure
        }
    };
}

// ── Config loading ────────────────────────────────────────────────────────

interface LoadedConfig<TAppConfig> {
    bootstrapConfig: Record<string, unknown>;
    appConfig: TAppConfig | undefined;
}

function loadYamlConfig<TAppConfig>(
    loader: ApplicationConfigLoader<TAppConfig>,
    fileContent: string | undefined,
): LoadedConfig<TAppConfig> {
    const bootstrapSection = loader.bootstrapSection ?? 'bootstrap';

    let raw: Record<string, unknown>;
    if (fileContent !== undefined) {
        raw = parseYamlObject(fileContent);
    } else if (loader.overrides) {
        raw = { ...loader.overrides };
    } else {
        raw = {};
    }

    // Interpolate environment variables (Node/Bun only)
    raw = interpolateTree(raw) as Record<string, unknown>;

    // Extract bootstrap section
    const bootstrapSection_ = raw[bootstrapSection];
    const bootstrapConfig: Record<string, unknown> =
        typeof bootstrapSection_ === 'object' && bootstrapSection_ !== null
            ? (bootstrapSection_ as Record<string, unknown>)
            : {};

    // Extract app config section
    let appConfig: TAppConfig | undefined;
    if (loader.appConfig) {
        const appSection = loader.appSection;
        const appRaw = appSection
            ? raw[appSection]
            : (() => {
                  // Default: full remaining object minus bootstrap section
                  const remaining: Record<string, unknown> = {};
                  for (const [key, value] of Object.entries(raw)) {
                      if (key !== bootstrapSection) {
                          remaining[key] = value;
                      }
                  }
                  return remaining;
              })();

        appConfig = validateAppConfig(loader.appConfig, appRaw, appSection ?? '*', loader.configFile);
    }

    return { bootstrapConfig, appConfig };
}

// ── Node/Bun options ──────────────────────────────────────────────────────

/**
 * Telemetry options for the Node subpath: the portable flags plus OTLP export
 * wiring. Presence of `endpoint` (with `enabled` not false) turns on Node OTel
 * export via `@gobing-ai/ts-infra/otel-node`.
 */
export interface NodeTelemetryBootstrapOptions extends TelemetryOptions {
    /** OTLP/HTTP collector endpoint base, e.g. `http://localhost:4318`. */
    endpoint?: string;
    /** Extra headers sent on every OTLP request (e.g. an auth token). */
    headers?: Record<string, string>;
}

/** Options for the Node/Bun convenience {@link runNodeApplication}. */
export interface NodeApplicationOptions<TAppConfig = unknown, TEvents extends EventMap = InfraEvents> {
    /** YAML config loading options. When omitted, uses defaults. */
    readonly configLoader?: ApplicationConfigLoader<TAppConfig>;
    /** Inline bootstrap config (overrides YAML-loaded config). */
    readonly config?: {
        logging?: LoggingOptions;
        events?: EventsOptions<TEvents>;
        telemetry?: NodeTelemetryBootstrapOptions;
        scheduler?: SchedulerOptions;
    };
    /** Pre-built services to inject. */
    readonly services?: ApplicationBootstrapOptions<TAppConfig, TEvents>['services'];
    /** User callback: application logic. */
    readonly start: (app: ApplicationRuntime<TAppConfig, TEvents>) => Promise<void> | void;
    /** User callback: cleanup before services shut down. */
    readonly stop?: (
        app: ApplicationRuntime<TAppConfig, TEvents>,
        reason: ApplicationStopReason,
    ) => Promise<void> | void;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Node/Bun convenience application bootstrap.
 *
 * Extends the portable `runApplication` with:
 * - YAML config file loading with section splitting
 * - Application-specific config validation
 * - File log sink creation from `logging.filePath`
 * - Bun SQLite DB adapter creation when `database.enabled` + `database.driver`
 * - Optional Node OTel telemetry exporter
 * - Optional Node scheduler adapter
 *
 * @example
 * ```ts
 * import { runNodeApplication } from '@gobing-ai/ts-infra/application-node';
 *
 * await runNodeApplication({
 *     configLoader: {
 *         configFile: 'config/app.yaml',
 *         bootstrapSection: 'bootstrap',
 *         appSection: 'billing',
 *         appConfig: {
 *             safeParse(raw) {
 *                 return billingSchema.safeParse(raw);
 *             },
 *         },
 *     },
 *     async start(app) {
 *         app.logger.info('started');
 *     },
 * });
 * ```
 */
export async function runNodeApplication<TAppConfig = unknown, TEvents extends EventMap = InfraEvents>(
    options: NodeApplicationOptions<TAppConfig, TEvents>,
): Promise<ApplicationRuntime<TAppConfig, TEvents>> {
    // ── Load config ─────────────────────────────────────────────────────
    let loadedAppConfig: TAppConfig | undefined;
    let yamlBootstrap: Record<string, unknown> = {};

    if (options.configLoader?.configFile) {
        const fileContent = readFileSync(options.configLoader.configFile, 'utf-8');
        const loaded = loadYamlConfig(options.configLoader, fileContent);
        yamlBootstrap = loaded.bootstrapConfig;
        loadedAppConfig = loaded.appConfig;
    } else if (options.configLoader) {
        const loaded = loadYamlConfig(options.configLoader, undefined);
        yamlBootstrap = loaded.bootstrapConfig;
        loadedAppConfig = loaded.appConfig;
    }

    // ── Resolve bootstrap config from YAML + inline options ────────────
    const yamlLog = yamlBootstrap.logging as Partial<LoggingOptions> | undefined;
    const yamlTel = yamlBootstrap.telemetry as Partial<NodeTelemetryBootstrapOptions> | undefined;
    const yamlSched = yamlBootstrap.scheduler as Partial<SchedulerOptions> | undefined;
    const yamlEvents = yamlBootstrap.events as Partial<EventsOptions<TEvents>> | undefined;
    const databaseOpts = (yamlBootstrap.database ?? {}) as Record<string, unknown>;

    const loggingOpts: Partial<LoggingOptions> = { ...yamlLog, ...options.config?.logging };
    const telemetryOpts: Partial<NodeTelemetryBootstrapOptions> = { ...yamlTel, ...options.config?.telemetry };
    const schedulerOpts: Partial<SchedulerOptions> = { ...yamlSched, ...options.config?.scheduler };
    const eventsOpts: EventsOptions<TEvents> = { ...yamlEvents, ...options.config?.events };

    const logFilePath = (yamlBootstrap.logging as Record<string, unknown> | undefined)?.filePath as string | undefined;
    const loggingConfig: Partial<LoggingOptions> =
        typeof logFilePath === 'string' ? { ...loggingOpts, fileSink: createFileSink(logFilePath) } : loggingOpts;

    // ── Scheduler adapter ───────────────────────────────────────────────
    // Honour a caller-supplied `SchedulerOptions.adapter` (documented injection
    // point, application/types.ts:82) instead of unconditionally overwriting
    // it. Only default-construct a NodeSchedulerAdapter when none was provided.
    // `drainTimeoutMs` (ADR-024) is reachable by passing a pre-built adapter;
    // the auto-wired default keeps the 30000 ms bound (CHANGELOG.md:16).
    const schedulerConfig: SchedulerOptions = {};
    if (schedulerOpts.enabled === true) {
        schedulerConfig.enabled = true;
        schedulerConfig.autoStart = schedulerOpts.autoStart;
        schedulerConfig.adapter = schedulerOpts.adapter ?? new NodeSchedulerAdapter();
        if (schedulerOpts.entries) {
            schedulerConfig.entries = schedulerOpts.entries;
        }
    }

    // ── Node-owned plugins ──────────────────────────────────────────────
    const plugins: Plugin[] = [];
    let dbAdapter: DbAdapterLike | undefined = options.services?.db;

    // Node OTel telemetry as a failFast plugin
    const otlpEndpoint = telemetryOpts.endpoint;
    if (telemetryOpts.enabled !== false && otlpEndpoint) {
        const otlpHeaders = telemetryOpts.headers;
        const serviceName = telemetryOpts.serviceName ?? 'ts-libs';
        plugins.push({
            name: 'builtin:node-telemetry',
            version: '0.0.0',
            failFast: true,
            // Providers must register during loadAll: the OTel metrics API has no
            // proxy provider, so instruments created by telemetryPlugin's onStart
            // (`initMetrics` pre-warm) bind permanently to whatever meter provider
            // is global at that moment. loadAll runs before every onStart.
            onLoad: async () => {
                initNodeTelemetry({
                    serviceName,
                    endpoint: otlpEndpoint,
                    ...(otlpHeaders ? { headers: otlpHeaders } : {}),
                });
            },
            onStop: async () => {
                await shutdownNodeTelemetry();
            },
        });
    }

    // DB adapter (owned — registered as a plugin with fail-soft close)
    if (!dbAdapter && databaseOpts.enabled === true) {
        const driver = databaseOpts.driver as string | undefined;
        if (driver === 'bun-sqlite') {
            const adapter = await createDbAdapter({
                driver: 'bun-sqlite',
                url: databaseOpts.url as string | undefined,
            });
            dbAdapter = adapter as DbAdapter;
            plugins.push(dbPlugin(dbAdapter));
        } else {
            throw new ConfigValidationError(
                `database.enabled is true but driver ${driver ? `"${driver}"` : 'is missing'} is not supported ` +
                    `(expected "bun-sqlite"). Provide a supported driver or inject a DbAdapter via services.db.`,
            );
        }
    }

    // ── Inject Node file observer (ADR-011 writer for the JSONL bus log) ──
    // The portable `runApplication` never opens files; the Node subpath
    // supplies the writer and resolves the default path against the project
    // root. Caller-provided `services.fileObserverWriter` and
    // `config.events.filePath` overrides win; `fileObserver: false` disables.
    const injectedFileSystem = createNodeFileSystem();
    const fileObserverWriter = options.services?.fileObserverWriter ?? {
        ensureDir: (dir: string) => {
            mkdirSync(dir, { recursive: true });
        },
        appendFile: (path: string, content: string) => {
            appendFileSync(path, content);
        },
    };
    const eventsFilePath = eventsOpts.filePath ?? injectedFileSystem.resolve('.spur', 'logs', 'system-events.jsonl');
    const eventsConfig: EventsOptions<TEvents> = {
        ...eventsOpts,
        filePath: eventsFilePath,
        ...(eventsOpts.fileObserver === false ? {} : { fileObserver: true }),
    };

    // ── Delegate to portable runApplication ─────────────────────────────
    // Node-specific cleanup is handled by plugins in the service ring —
    // node-telemetry onStop, owned-db onStop. No manual try/catch or stop
    // override needed.
    return await runApplication<TAppConfig, TEvents>({
        config: {
            ...options.config,
            logging: loggingConfig,
            telemetry: telemetryOpts,
            scheduler: schedulerConfig,
            events: eventsConfig,
        },
        appConfig: loadedAppConfig,
        services: { ...options.services, fileObserverWriter, ...(dbAdapter ? { db: dbAdapter } : {}) },
        start: options.start,
        stop: options.stop,
        plugins: plugins.length ? plugins : undefined,
    });
}
