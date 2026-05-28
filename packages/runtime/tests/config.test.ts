import { describe, expect, test } from 'bun:test';

import {
    buildConfigFromObject,
    buildConfigFromYaml,
    ConfigLoadError,
    deepMerge,
    deFlattenKeys,
    flattenKeys,
    getDatabaseUrl,
    getNodeEnv,
    interpolateEnv,
    interpolateTree,
    isTestEnv,
    parseConfigYaml,
} from '../src/config';

describe('config helpers', () => {
    test('interpolates environment variables in strings and trees', () => {
        process.env.RUNTIME_TEST_VALUE = 'secret';
        const existing = '$' + '{RUNTIME_TEST_VALUE}';
        const missing = '$' + '{MISSING_RUNTIME_TEST_VALUE}';

        expect(interpolateEnv(`x-${existing}-${missing}`)).toBe(`x-secret-${missing}`);
        expect(interpolateTree({ a: existing, list: [existing] })).toEqual({
            a: 'secret',
            list: ['secret'],
        });

        delete process.env.RUNTIME_TEST_VALUE;
    });

    test('deep-merges, flattens, and de-flattens config objects', () => {
        expect(deepMerge({ app: { port: 3000, env: 'development' } }, { app: { port: 4000 } })).toEqual({
            app: { port: 4000, env: 'development' },
        });

        const flattened = flattenKeys({ app: { port: 3000 }, enabled: true });
        expect(flattened).toEqual({ 'app.port': '3000', enabled: 'true' });
        expect(deFlattenKeys(flattened)).toEqual({ app: { port: 3000 }, enabled: true });
    });

    test('builds frozen validated config with overrides', () => {
        const config = buildConfigFromObject(
            { app: { name: 'demo', port: 3001 }, database: { url: 'file.db' } },
            { overrides: { app: { name: 'demo', env: 'test', port: 3002 } } },
        );

        expect(config.app).toEqual({ name: 'demo', env: 'test', port: 3002 });
        expect(config.database.url).toBe('file.db');
        expect(Object.isFrozen(config)).toBe(true);
        expect(Object.isFrozen(config.app)).toBe(true);
    });

    test('parses YAML config text and builds config from it', () => {
        expect(parseConfigYaml('app:\n  name: yaml-demo\n  env: test\n')).toEqual({
            app: { name: 'yaml-demo', env: 'test' },
        });
        expect(buildConfigFromYaml('app:\n  port: 3010\n').app.port).toBe(3010);
        expect(buildConfigFromYaml('').app.port).toBe(3000);
        expect(() => parseConfigYaml('- item')).toThrow(ConfigLoadError);
        expect(() => parseConfigYaml('app:\n  name: "unmatched')).toThrow(ConfigLoadError);
    });

    test('throws ConfigLoadError for invalid input', () => {
        expect(() => buildConfigFromObject({ app: { port: -1 } })).toThrow(ConfigLoadError);
    });

    test('reads runtime environment helpers', () => {
        const previousNodeEnv = process.env.NODE_ENV;
        const previousDatabaseUrl = process.env.DATABASE_URL;

        process.env.NODE_ENV = 'test';
        process.env.DATABASE_URL = 'sqlite://test';

        expect(getNodeEnv()).toBe('test');
        expect(isTestEnv()).toBe(true);
        expect(getDatabaseUrl()).toBe('sqlite://test');

        if (previousNodeEnv === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = previousNodeEnv;
        }
        if (previousDatabaseUrl === undefined) {
            delete process.env.DATABASE_URL;
        } else {
            process.env.DATABASE_URL = previousDatabaseUrl;
        }
    });
});
