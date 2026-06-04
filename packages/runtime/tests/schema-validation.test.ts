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

    test('reads config and local schema through an injected fileSystem instead of the global', async () => {
        // Both reads (config + relative schema) must route through the injected FS, so a test can
        // supply a virtual file system without touching the deprecated getFs() global.
        const reads: string[] = [];
        const files: Record<string, string> = {
            '/virtual/config.yaml': '$schema: ./schema.json\nname: demo\n',
            // The relative ref is resolved against the config's directory; joinPath preserves the `./` segment.
            '/virtual/./schema.json': JSON.stringify({
                type: 'object',
                required: ['name'],
                properties: { $schema: { type: 'string' }, name: { type: 'string' } },
            }),
        };
        const fileSystem = {
            readFile: (path: string): string => {
                reads.push(path);
                const content = files[path];
                if (content === undefined) throw new Error(`unexpected read: ${path}`);
                return content;
            },
        };

        const parsed = await loadStructuredConfig('/virtual/config.yaml', { fileSystem });

        expect(parsed).toMatchObject({ name: 'demo' });
        expect(reads).toEqual(['/virtual/config.yaml', '/virtual/./schema.json']);
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

    test('rejects an oversized remote schema by Content-Length before reading the body', async () => {
        await expect(
            parseStructuredConfig('$schema: https://schemas.example/big.json\nname: demo\n', 'remote.yaml', {
                fetch: async () => new Response('{}', { headers: { 'content-length': String(6 * 1024 * 1024) } }),
            }),
        ).rejects.toThrow('exceeds the');
    });

    test('aborts a remote schema whose streamed body exceeds the byte cap (lying Content-Length)', async () => {
        // No/dishonest Content-Length: the streaming tally must still stop a multi-MB drip.
        const oversized = new ReadableStream<Uint8Array>({
            start(controller) {
                const mb = new Uint8Array(1024 * 1024);
                for (let i = 0; i < 6; i++) controller.enqueue(mb);
                controller.close();
            },
        });

        await expect(
            parseStructuredConfig('$schema: https://schemas.example/drip.json\nname: demo\n', 'remote.yaml', {
                fetch: async () => new Response(oversized),
            }),
        ).rejects.toThrow('exceeds the');
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

    test('terminates on cyclic $ref instead of overflowing the stack', () => {
        // A self-referential $ref (node → node) is a DoS surface: unguarded it recurses until the
        // stack overflows. The visited-ref guard breaks the cycle, so validation must simply return.
        const recursive = {
            $ref: '#/$defs/node',
            $defs: {
                node: {
                    type: 'object',
                    properties: { child: { $ref: '#/$defs/node' } },
                },
            },
        };

        expect(validateJsonSchema({ child: { child: {} } }, recursive)).toEqual([]);
        // Sibling constraints under the cyclic ref still fire — the guard stops recursion, not checks.
        const constrained = {
            $ref: '#/$defs/node',
            $defs: {
                node: {
                    type: 'object',
                    required: ['child'],
                    properties: { child: { $ref: '#/$defs/node' } },
                },
            },
        };
        expect(validateJsonSchema({}, constrained)).toHaveLength(1);
    });

    test('treats object const/enum members as order-insensitive', () => {
        expect(validateJsonSchema({ a: 1, b: 2 }, { const: { b: 2, a: 1 } })).toEqual([]);
        expect(validateJsonSchema({ a: 1, b: 2 }, { enum: [{ b: 2, a: 1 }] })).toEqual([]);
        expect(validateJsonSchema({ a: 1, b: 3 }, { const: { b: 2, a: 1 } })).toHaveLength(1);
    });
});
