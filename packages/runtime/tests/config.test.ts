import { describe, expect, test } from 'bun:test';

import {
    buildConfigFromObject,
    buildConfigFromYaml,
    ConfigLoadError,
    getDatabaseUrl,
    getNodeEnv,
    interpolateEnv,
    interpolateTree,
    isTestEnv,
    parseConfigYaml,
    parseYamlObject,
    stringifyYamlObject,
    YamlParseError,
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

describe('YAML utilities', () => {
    test('parseYamlObject parses scalars, arrays, nested objects', () => {
        const result = parseYamlObject(
            ['name: Coder', 'count: 3', 'enabled: true', 'tags: [code, team]', 'config:', '  model: gpt-5'].join('\n'),
        );
        expect(result).toEqual({
            name: 'Coder',
            count: 3,
            enabled: true,
            tags: ['code', 'team'],
            config: { model: 'gpt-5' },
        });
    });

    test('parseYamlObject returns {} for empty/null input', () => {
        expect(parseYamlObject('')).toEqual({});
        expect(parseYamlObject('null')).toEqual({});
    });

    test('parseYamlObject throws YamlParseError on invalid YAML', () => {
        expect(() => parseYamlObject('key: "unclosed')).toThrow(YamlParseError);
    });

    test('parseYamlObject throws YamlParseError when root is not an object', () => {
        expect(() => parseYamlObject('- item')).toThrow(YamlParseError);
        expect(() => parseYamlObject('42')).toThrow(YamlParseError);
    });

    test('stringifyYamlObject round-trips through parseYamlObject', () => {
        const value: Record<string, unknown> = { name: 'Coder', tags: ['a', 'b'], config: { model: 'gpt-5' } };
        expect(parseYamlObject(stringifyYamlObject(value))).toEqual(value);
    });

    test('stringifyYamlObject preserves nested objects', () => {
        const text = stringifyYamlObject({ outer: { inner: { level: 'deep' } } });
        expect(parseYamlObject(text)).toEqual({ outer: { inner: { level: 'deep' } } });
    });
});
