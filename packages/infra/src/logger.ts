/**
 * Structured logger for ts-infra, backed by LogTape.
 *
 * LogTape owns level filtering, sink routing, and formatting; this module
 * adapts LogTape's template-string logger to the ts-infra `Logger` contract
 * (`method(msg, data?)` + `child(context)`) so call-sites stay backend-agnostic.
 *
 * ADR-011: ts-infra must not touch `node:fs`/`process.stderr`. The console sink
 * is LogTape's own (`getConsoleSink`); the file sink is supplied by the caller
 * (typically `@gobing-ai/ts-runtime`, which owns FileSystem) via
 * {@link InitLoggerOptions.fileSink}.
 */

import {
    ConfigError,
    configure,
    getConsoleSink,
    getJsonLinesFormatter,
    getTextFormatter,
    type LogRecord,
    type Logger as LtLogger,
    getLogger as ltGetLogger,
    reset,
    type Sink,
} from '@logtape/logtape';

/** Log severity levels in ascending order: trace → debug → info → warn → error → fatal. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** Root category every ts-infra logger lives under, so one config rule covers them all. */
const ROOT_CATEGORY = 'app';

/** Map the ts-infra level name to LogTape's (`warn` → `warning`). */
function toLogTapeLevel(level: LogLevel): 'trace' | 'debug' | 'info' | 'warning' | 'error' | 'fatal' {
    return level === 'warn' ? 'warning' : level;
}

/**
 * Structured logger interface with level methods and context inheritance
 * via {@link Logger.child}. `data` is attached as structured properties —
 * `msg` is logged verbatim (no template substitution).
 */
export interface Logger {
    trace(msg: string, data?: Record<string, unknown>): void;
    debug(msg: string, data?: Record<string, unknown>): void;
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
    fatal(msg: string, data?: Record<string, unknown>): void;
    child(context: Record<string, unknown>): Logger;
}

/** Module-level mute flag — LogTape has no global mute, so the adapter gates on it. */
let muted = false;

/**
 * Mute or unmute all logger output. Useful for tests. Gating happens in the
 * adapter before delegating to LogTape, so muting is synchronous and global.
 */
export function setLoggerMuted(value: boolean): void {
    muted = value;
}

/** Adapter: ts-infra `Logger` over a LogTape logger. */
class LogTapeLogger implements Logger {
    constructor(private readonly inner: LtLogger) {}

    trace(msg: string, data?: Record<string, unknown>): void {
        if (!muted) this.inner.trace(msg, data ?? {});
    }
    debug(msg: string, data?: Record<string, unknown>): void {
        if (!muted) this.inner.debug(msg, data ?? {});
    }
    info(msg: string, data?: Record<string, unknown>): void {
        if (!muted) this.inner.info(msg, data ?? {});
    }
    warn(msg: string, data?: Record<string, unknown>): void {
        if (!muted) this.inner.warn(msg, data ?? {});
    }
    error(msg: string, data?: Record<string, unknown>): void {
        if (!muted) this.inner.error(msg, data ?? {});
    }
    fatal(msg: string, data?: Record<string, unknown>): void {
        if (!muted) this.inner.fatal(msg, data ?? {});
    }

    child(context: Record<string, unknown>): Logger {
        return new LogTapeLogger(this.inner.with(context));
    }
}

/**
 * Get a logger for the given category. Categories are nested under the
 * `app` root so a single `initializeLogger` rule configures them all.
 */
export function getLogger(category: string): Logger {
    return new LogTapeLogger(ltGetLogger([ROOT_CATEGORY, category]));
}

/** Options for {@link initializeLogger}. */
export interface InitLoggerOptions {
    /** Minimum level to emit. Default `info`. */
    level?: LogLevel;
    /** Enable the console sink. Default `true`. */
    console?: boolean;
    /**
     * File sink writer. ts-infra never opens files itself (ADR-011); the
     * caller (e.g. ts-runtime FileSystem) provides a writer that appends one
     * already-formatted line per record. When omitted, no file sink is wired.
     */
    fileSink?: (line: string) => void;
    /** Format records as JSON Lines (`true`) or human-readable text (`false`). Default `true`. */
    json?: boolean;
}

/**
 * Configure LogTape with console and/or file sinks. Call once at startup;
 * safe to call again to reconfigure — the prior config is reset first so the
 * latest call wins (LogTape throws `ConfigError` on double-configure otherwise).
 */
export async function initializeLogger(options: InitLoggerOptions = {}): Promise<void> {
    const { level = 'info', console: enableConsole = true, fileSink, json = true } = options;
    const lowestLevel = toLogTapeLevel(level);
    const formatter = json ? getJsonLinesFormatter() : getTextFormatter();

    // When muted, install no sinks regardless of `console`/`fileSink`. The
    // adapter flag (`setLoggerMuted`) is the single source of truth for "silence
    // everything": without this, a reconfigure after muting would reinstall a
    // console sink and resurface output the caller explicitly silenced. Keeping
    // both mute paths consistent makes `setLoggerMuted(true)` survive any later
    // `initializeLogger` (e.g. an application bootstrap running under a muted
    // test harness).
    const sinks: Record<string, Sink> = {};
    if (!muted && enableConsole) {
        sinks.console = getConsoleSink({ formatter });
    }
    if (!muted && fileSink) {
        sinks.file = (record: LogRecord) => {
            fileSink(formatter(record));
        };
    }

    await reset();
    try {
        await configure({
            sinks,
            loggers: [
                { category: [ROOT_CATEGORY], lowestLevel, sinks: Object.keys(sinks) },
                { category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: [] },
            ],
        });
    } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
    }
}
