import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
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
});
