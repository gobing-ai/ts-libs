import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteAgentSpec, loadAgentSpecs, saveAgentSpec, ValueError, validateAgentId } from '../src';

describe('AgentSpec persistence', () => {
    test('save/load/delete round-trips agent specs', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'agent-spec-'));
        await saveAgentSpec(
            {
                id: 'coder',
                name: 'Coder',
                type: 'codex',
                workspace: '/repo',
                purpose: 'Implement changes',
                tags: ['code', 'team'],
                autoStart: true,
                config: { model: 'gpt-5', systemPrompt: 'Be precise.', autonomy: { level: 'high' } },
            },
            dir,
        );

        const specs = await loadAgentSpecs(dir);
        expect(specs).toHaveLength(1);
        expect(specs[0]).toMatchObject({
            id: 'coder',
            tags: ['code', 'team'],
            config: { model: 'gpt-5', systemPrompt: 'Be precise.', autonomy: { level: 'high' } },
            autoStart: true,
        });

        await deleteAgentSpec('coder', dir);
        expect(await loadAgentSpecs(dir)).toEqual([]);
    });

    test('validateAgentId rejects invalid ids', () => {
        expect(validateAgentId('coder-1')).toBe('coder-1');
        expect(() => validateAgentId('Coder')).toThrow(ValueError);
        expect(() => validateAgentId('x')).toThrow(ValueError);
    });

    test('loadAgentSpecs rejects duplicate ids', () => {
        const dir = mkdtempSync(join(tmpdir(), 'agent-spec-dupe-'));
        const source = [
            'id: coder',
            'name: Coder',
            'type: codex',
            'workspace: /repo',
            'purpose: Implement',
            'tags: [code]',
            'config:',
            '  model: gpt-5',
            '',
        ].join('\n');
        writeFileSync(join(dir, 'a.yaml'), source);
        writeFileSync(join(dir, 'b.yaml'), source);
        return expect(loadAgentSpecs(dir)).rejects.toThrow('Duplicate agent id "coder"');
    });

    test('loadAgentSpecs rejects missing required fields', () => {
        const dir = mkdtempSync(join(tmpdir(), 'agent-spec-missing-'));
        writeFileSync(join(dir, 'a.yaml'), 'id: coder\nname: Coder\ntype: codex');
        return expect(loadAgentSpecs(dir)).rejects.toThrow(ValueError);
    });

    test('loadAgentSpecs rejects non-array tags', () => {
        const dir = mkdtempSync(join(tmpdir(), 'agent-spec-bad-tags-'));
        const source = [
            'id: coder',
            'name: Coder',
            'type: codex',
            'workspace: /repo',
            'purpose: Implement',
            'tags: "not-an-array"',
            'config:',
            '  model: gpt-5',
            '',
        ].join('\n');
        writeFileSync(join(dir, 'a.yaml'), source);
        return expect(loadAgentSpecs(dir)).rejects.toThrow('"tags" must be a string array');
    });

    test('loadAgentSpecs rejects non-object config', () => {
        const dir = mkdtempSync(join(tmpdir(), 'agent-spec-bad-config-'));
        const source = [
            'id: coder',
            'name: Coder',
            'type: codex',
            'workspace: /repo',
            'purpose: Implement',
            'tags: [code]',
            'config: "not-an-object"',
            '',
        ].join('\n');
        writeFileSync(join(dir, 'a.yaml'), source);
        return expect(loadAgentSpecs(dir)).rejects.toThrow('"config" must be an object');
    });

    test('loadAgentSpecs returns empty array for missing directory', async () => {
        const specs = await loadAgentSpecs('/nonexistent/agent-spec-dir');
        expect(specs).toEqual([]);
    });
});
