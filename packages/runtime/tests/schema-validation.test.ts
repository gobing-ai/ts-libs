import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStructuredConfig, parseStructuredConfig, StructuredConfigSchemaError, validateJsonSchema } from '../src';

describe('loadStructuredConfig', () => {
    test('validates a YAML file against a relative JSON schema ref by default', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'structured-config-'));
        const schemaPath = join(dir, 'schema.json');
        const configPath = join(dir, 'config.yaml');
        await writeFile(
            schemaPath,
            JSON.stringify({
                type: 'object',
                additionalProperties: false,
                required: ['name'],
                properties: {
                    $schema: { type: 'string' },
                    name: { type: 'string' },
                },
            }),
        );
        await writeFile(configPath, '$schema: ./schema.json\nname: demo\nextra: nope\n');

        await expect(loadStructuredConfig(configPath)).rejects.toThrow(StructuredConfigSchemaError);
        expect(await loadStructuredConfig(configPath, { validateSchema: false })).toMatchObject({ name: 'demo' });
    });

    test('refuses remote schema refs by default and allows opt-in via allowRemote', async () => {
        const config = '$schema: https://schemas.example/config.json\nname: demo\n';

        await expect(parseStructuredConfig(config, 'remote.yaml')).rejects.toThrow('Refusing to fetch remote');

        // allowRemote opts in; stub global fetch so no real network call happens.
        const original = globalThis.fetch;
        globalThis.fetch = (async () =>
            new Response(
                JSON.stringify({
                    type: 'object',
                    required: ['name'],
                    properties: { $schema: { type: 'string' }, name: { type: 'string' } },
                }),
            )) as unknown as typeof fetch;
        try {
            expect(await parseStructuredConfig(config, 'remote.yaml', { allowRemote: true })).toMatchObject({
                name: 'demo',
            });
        } finally {
            globalThis.fetch = original;
        }
    });

    test('resolves a bundled package-specifier schema ref through the module resolver', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'structured-config-pkg-'));
        const pkgRoot = join(dir, 'node_modules', '@scope', 'demo');
        await mkdir(join(pkgRoot, 'schemas'), { recursive: true });
        await writeFile(join(pkgRoot, 'package.json'), JSON.stringify({ name: '@scope/demo' }));
        await writeFile(
            join(pkgRoot, 'schemas', 'config.schema.json'),
            JSON.stringify({
                type: 'object',
                additionalProperties: false,
                required: ['name'],
                properties: { $schema: { type: 'string' }, name: { type: 'string' } },
            }),
        );

        // Inject a resolver that maps the package.json specifier to the on-disk manifest.
        const resolve = (specifier: string): string => {
            if (specifier === '@scope/demo/package.json') return join(pkgRoot, 'package.json');
            throw new Error(`unexpected specifier ${specifier}`);
        };

        await expect(
            parseStructuredConfig(
                '$schema: "@scope/demo/schemas/config.schema.json"\nname: demo\nextra: nope\n',
                'c.yaml',
                {
                    resolve,
                },
            ),
        ).rejects.toThrow(StructuredConfigSchemaError);

        expect(
            await parseStructuredConfig('$schema: "@scope/demo/schemas/config.schema.json"\nname: demo\n', 'c.yaml', {
                resolve,
            }),
        ).toMatchObject({ name: 'demo' });
    });

    test('supports remote schema refs through an injected fetch implementation', async () => {
        const parsed = await parseStructuredConfig(
            '$schema: https://schemas.example/config.json\nname: demo\n',
            'remote.yaml',
            {
                fetch: async () =>
                    new Response(
                        JSON.stringify({
                            type: 'object',
                            additionalProperties: false,
                            required: ['name'],
                            properties: {
                                $schema: { type: 'string' },
                                name: { type: 'string' },
                            },
                        }),
                    ),
            },
        );

        expect(parsed).toMatchObject({ name: 'demo' });

        await expect(
            parseStructuredConfig('$schema: https://schemas.example/config.json\nname: demo\n', 'remote.yaml', {
                fetch: async () => new Response('missing', { status: 404 }),
            }),
        ).rejects.toThrow('HTTP 404');
    });

    test('reports invalid JSON in referenced schema files', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'structured-config-invalid-schema-'));
        const configPath = join(dir, 'config.yaml');
        await writeFile(join(dir, 'schema.json'), '{ not json');
        await writeFile(configPath, '$schema: ./schema.json\nname: demo\n');

        await expect(loadStructuredConfig(configPath)).rejects.toThrow('Invalid JSON schema');
    });

    test('validates JSON schema refs, combinators, arrays, and const values', () => {
        expect(
            validateJsonSchema(
                { name: 'demo' },
                {
                    $ref: '#/$defs/named',
                    $defs: {
                        named: {
                            type: 'object',
                            required: ['name'],
                            properties: { name: { type: 'string' } },
                        },
                    },
                },
            ),
        ).toEqual([]);

        expect(validateJsonSchema('a', { oneOf: [{ const: 'a' }, { const: 'b' }] })).toEqual([]);
        expect(validateJsonSchema('a', { anyOf: [{ const: 'x' }, { const: 'a' }] })).toEqual([]);
        expect(validateJsonSchema('z', { anyOf: [{ const: 'x' }, { const: 'a' }] })).toHaveLength(1);
        expect(validateJsonSchema(['x'], { type: 'array', items: { type: 'integer' } })[0]?.message).toContain(
            'expected integer',
        );
        expect(validateJsonSchema(null, { type: 'object' })[0]?.message).toContain('null');
        expect(validateJsonSchema([], { type: 'object' })[0]?.message).toContain('array');
    });

    test('applies $ref/combinator keywords alongside their siblings (logical AND)', () => {
        // $ref + sibling `required`: the local `required` must still apply.
        const schema = {
            $ref: '#/$defs/base',
            required: ['extra'],
            $defs: { base: { type: 'object', properties: { name: { type: 'string' } } } },
        };
        expect(validateJsonSchema({ name: 'demo' }, schema)).toHaveLength(1); // missing `extra`
        expect(validateJsonSchema({ name: 'demo', extra: 1 }, schema)).toEqual([]);

        // oneOf + sibling `type`: a value failing the sibling type must fail even if a branch matches.
        const typed = { type: 'string', oneOf: [{ const: 'a' }, { const: 1 }] };
        expect(validateJsonSchema(1, typed).some((v) => v.message.includes('expected string'))).toBe(true);
        expect(validateJsonSchema('a', typed)).toEqual([]);
    });

    test('fails oneOf when more than one branch matches', () => {
        const result = validateJsonSchema(5, { oneOf: [{ type: 'integer' }, { type: 'number' }] });
        expect(result).toHaveLength(1);
        expect(result[0]?.message).toContain('matched 2');
    });

    test('reports every branch when no combinator branch matches', () => {
        const result = validateJsonSchema('z', { oneOf: [{ const: 'a' }, { const: 'b' }] });
        expect(result[0]?.message).toContain('[0]');
        expect(result[0]?.message).toContain('[1]');
    });

    test('treats object const/enum members as order-insensitive', () => {
        expect(validateJsonSchema({ a: 1, b: 2 }, { const: { b: 2, a: 1 } })).toEqual([]);
        expect(validateJsonSchema({ a: 1, b: 2 }, { enum: [{ b: 2, a: 1 }] })).toEqual([]);
        expect(validateJsonSchema({ a: 1, b: 3 }, { const: { b: 2, a: 1 } })).toHaveLength(1);
    });
});
