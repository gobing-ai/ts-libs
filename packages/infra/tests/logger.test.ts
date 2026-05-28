import { describe, expect, test } from 'bun:test';
import { getLogger, initializeLogger, setLoggerMuted } from '../src/logger';

setLoggerMuted(true);

describe('logger', () => {
    test('getLogger creates and caches logger instances', () => {
        const log1 = getLogger('test-logger');
        const log2 = getLogger('test-logger');
        expect(log1).toBe(log2);
    });

    test('getLogger creates distinct loggers for different categories', () => {
        const log1 = getLogger('cat-a');
        const log2 = getLogger('cat-b');
        expect(log1).not.toBe(log2);
    });

    test('logger has all log methods', () => {
        const log = getLogger('methods-test');
        expect(typeof log.trace).toBe('function');
        expect(typeof log.debug).toBe('function');
        expect(typeof log.info).toBe('function');
        expect(typeof log.warn).toBe('function');
        expect(typeof log.error).toBe('function');
        expect(typeof log.fatal).toBe('function');
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

    test('child logger creates new instance with context', () => {
        const log = getLogger('parent');
        const child = log.child({ requestId: '123' });
        expect(child).toBeDefined();
        expect(typeof child.info).toBe('function');
        // Child should be a different instance
        expect(child).not.toBe(log);
    });

    test('initializeLogger resets loggers', () => {
        const before = getLogger('reset-test');
        initializeLogger('debug');
        const after = getLogger('reset-test');
        expect(after).not.toBe(before);
    });
});
