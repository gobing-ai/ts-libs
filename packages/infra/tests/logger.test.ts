import { afterEach, describe, expect, test } from 'bun:test';
import { getLogger, initializeLogger, type Logger, setLoggerMuted } from '../src/logger';

/**
 * The logger is backed by LogTape. We assert behavior through an injected
 * `fileSink` (the ADR-011 sink-injection seam) rather than spying on the
 * console: the sink receives one formatted JSON line per emitted record, so
 * it doubles as a deterministic test probe for level filtering and context.
 */

/** Capture sink output; returns the lines array and the writer to inject. */
function captureSink(): { lines: string[]; write: (line: string) => void } {
    const lines: string[] = [];
    return { lines, write: (line: string) => lines.push(line) };
}

afterEach(async () => {
    setLoggerMuted(false);
    // Reset to a quiet console-only config so leaked state doesn't affect others.
    await initializeLogger({ console: false });
});

describe('logger', () => {
    test('getLogger returns a Logger with all level methods and child', () => {
        const log = getLogger('methods-test');
        for (const m of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
            expect(typeof log[m]).toBe('function');
        }
        expect(typeof log.child).toBe('function');
    });

    test('log methods do not throw', () => {
        const log = getLogger('no-throw');
        expect(() => log.info('test message')).not.toThrow();
        expect(() => log.warn('warning', { code: 1 })).not.toThrow();
        expect(() => log.error('error message')).not.toThrow();
        expect(() => log.debug('debug message')).not.toThrow();
        expect(() => log.trace('trace message')).not.toThrow();
        expect(() => log.fatal('fatal message')).not.toThrow();
    });

    test('child logger is a distinct instance', () => {
        const log = getLogger('parent');
        const child = log.child({ requestId: '123' });
        expect(child).toBeDefined();
        expect(child).not.toBe(log);
        expect(typeof child.info).toBe('function');
    });

    test('routes emitted records to the injected file sink', async () => {
        const sink = captureSink();
        await initializeLogger({ level: 'info', console: false, fileSink: sink.write });

        getLogger('route-test').info('hello', { n: 1 });

        expect(sink.lines).toHaveLength(1);
        expect(sink.lines[0]).toContain('hello');
        expect(sink.lines[0]).toContain('"n":1');
    });

    test('suppresses records below the configured level', async () => {
        const sink = captureSink();
        await initializeLogger({ level: 'warn', console: false, fileSink: sink.write });

        const log = getLogger('filter-test');
        log.debug('below threshold — dropped');
        log.warn('at threshold — emitted');

        expect(sink.lines).toHaveLength(1);
        expect(sink.lines[0]).toContain('at threshold');
    });

    test('reconfiguring with a lower level lets a cached logger emit again', async () => {
        const sink = captureSink();
        await initializeLogger({ level: 'error', console: false, fileSink: sink.write });
        const log: Logger = getLogger('reconfig-test');

        log.info('dropped under error level');
        expect(sink.lines).toHaveLength(0);

        await initializeLogger({ level: 'info', console: false, fileSink: sink.write });
        log.info('emitted after lowering the level');
        expect(sink.lines).toHaveLength(1);
    });

    test('child context appears in emitted record properties', async () => {
        const sink = captureSink();
        await initializeLogger({ level: 'info', console: false, fileSink: sink.write });

        getLogger('ctx-test').child({ requestId: 'abc' }).info('with context');

        expect(sink.lines).toHaveLength(1);
        expect(sink.lines[0]).toContain('"requestId":"abc"');
    });

    test('setLoggerMuted suppresses all output', async () => {
        const sink = captureSink();
        await initializeLogger({ level: 'trace', console: false, fileSink: sink.write });

        setLoggerMuted(true);
        getLogger('mute-test').error('should be muted');
        expect(sink.lines).toHaveLength(0);

        setLoggerMuted(false);
        getLogger('mute-test').error('now visible');
        expect(sink.lines).toHaveLength(1);
    });

    test('initializeLogger installs no sinks while muted, so a later reconfigure cannot resurface output', async () => {
        const sink = captureSink();

        // Mute first (the test-harness pattern), then reconfigure with a sink
        // explicitly requested — as an application bootstrap would.
        setLoggerMuted(true);
        await initializeLogger({ level: 'trace', console: true, fileSink: sink.write });

        getLogger('mute-reconfig-test').error('must stay silent across reconfigure');
        expect(sink.lines).toHaveLength(0);

        // Unmuting and reconfiguring restores the sink — mute is not permanent.
        setLoggerMuted(false);
        await initializeLogger({ level: 'trace', console: false, fileSink: sink.write });
        getLogger('mute-reconfig-test').error('visible again after unmute + reconfigure');
        expect(sink.lines).toHaveLength(1);
    });
});
