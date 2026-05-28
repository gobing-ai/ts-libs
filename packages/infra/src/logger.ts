/**
 * Structured JSON logger with levels (trace/debug/info/warn/error/fatal).
 *
 * No external dependencies — console-based implementation.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_ORDER: Record<LogLevel, number> = {
    trace: 0,
    debug: 1,
    info: 2,
    warn: 3,
    error: 4,
    fatal: 5,
};

export interface Logger {
    trace(msg: string, data?: Record<string, unknown>): void;
    debug(msg: string, data?: Record<string, unknown>): void;
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
    fatal(msg: string, data?: Record<string, unknown>): void;
    child(context: Record<string, unknown>): Logger;
}

class ConsoleLogger implements Logger {
    private readonly context: Record<string, unknown>;

    constructor(
        private readonly category: string,
        private readonly minLevel: LogLevel = 'info',
        context: Record<string, unknown> = {},
    ) {
        this.context = { category, ...context };
    }

    private log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
        if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
        if (globalMuted) return;

        const entry = {
            level,
            message: msg,
            timestamp: new Date().toISOString(),
            ...this.context,
            ...data,
        };

        const json = JSON.stringify(entry);
        switch (level) {
            case 'error':
            case 'fatal':
                console.error(json);
                break;
            case 'warn':
                console.warn(json);
                break;
            case 'debug':
            case 'trace':
                console.debug(json);
                break;
            default:
                console.log(json);
        }
    }

    trace(msg: string, data?: Record<string, unknown>): void {
        this.log('trace', msg, data);
    }
    debug(msg: string, data?: Record<string, unknown>): void {
        this.log('debug', msg, data);
    }
    info(msg: string, data?: Record<string, unknown>): void {
        this.log('info', msg, data);
    }
    warn(msg: string, data?: Record<string, unknown>): void {
        this.log('warn', msg, data);
    }
    error(msg: string, data?: Record<string, unknown>): void {
        this.log('error', msg, data);
    }
    fatal(msg: string, data?: Record<string, unknown>): void {
        this.log('fatal', msg, data);
    }

    child(context: Record<string, unknown>): Logger {
        return new ConsoleLogger(this.category, this.minLevel, { ...this.context, ...context });
    }
}

const loggers = new Map<string, ConsoleLogger>();

let globalLevel: LogLevel = 'info';
let globalMuted = false;

/**
 * Mute or unmute all logger console output. Useful for tests.
 */
export function setLoggerMuted(muted: boolean): void {
    globalMuted = muted;
}

/**
 * Get or create a logger for the given category.
 */
export function getLogger(category: string): Logger {
    const existing = loggers.get(category);
    if (existing) return existing;

    const logger = new ConsoleLogger(category, globalLevel);
    loggers.set(category, logger);
    return logger;
}

/**
 * Initialize the logger subsystem with a minimum log level.
 */
export function initializeLogger(level: LogLevel = 'info'): void {
    globalLevel = level;
    loggers.clear();
}
