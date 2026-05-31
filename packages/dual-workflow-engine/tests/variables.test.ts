import { describe, expect, test } from 'bun:test';
import { WorkflowValidationError } from '../src/errors';
import { mergeVars, resolveTemplateString, resolveTemplates, type VariableContext } from '../src/variables';

describe('mergeVars', () => {
    test('overrides workflow vars with provided vars', () => {
        const result = mergeVars({ key: 'wf', shared: 'from-wf' }, { key: 'override' });
        expect(result).toEqual({ key: 'override', shared: 'from-wf' });
    });

    test('returns workflow vars unchanged when no overrides', () => {
        const result = mergeVars({ a: '1', b: '2' }, {});
        expect(result).toEqual({ a: '1', b: '2' });
    });

    test('returns override vars when workflow vars empty', () => {
        const result = mergeVars({}, { x: 'val' });
        expect(result).toEqual({ x: 'val' });
    });

    test('returns empty object when both empty', () => {
        const result = mergeVars();
        expect(result).toEqual({});
    });

    test('does not mutate input objects', () => {
        const wf = { a: '1' };
        const ov = { b: '2' };
        mergeVars(wf, ov);
        expect(wf).toEqual({ a: '1' });
        expect(ov).toEqual({ b: '2' });
    });
});

describe('resolveTemplateString', () => {
    const ctx: VariableContext = {
        vars: { name: 'world', count: '42' },
        env: { HOME: '/home/user', PATH: '/usr/bin' },
        builtins: { workflow: 'my-wf', runId: 'run-1' },
    };

    test('interpolates vars.* references', () => {
        const result = resolveTemplateString('Hello $' + '{vars.name}!', ctx);
        expect(result).toBe('Hello world!');
    });

    test('interpolates env.* references', () => {
        const result = resolveTemplateString('Home: $' + '{env.HOME}', ctx);
        expect(result).toBe('Home: /home/user');
    });

    test('interpolates builtin references', () => {
        const result = resolveTemplateString('WF[$' + '{workflow}] run[$' + '{runId}]', ctx);
        expect(result).toBe('WF[my-wf] run[run-1]');
    });

    test('handles multiple references in one string', () => {
        const result = resolveTemplateString('$' + '{vars.name}:$' + '{vars.count}', ctx);
        expect(result).toBe('world:42');
    });

    test('returns string unchanged when no templates', () => {
        const result = resolveTemplateString('plain text no vars', ctx);
        expect(result).toBe('plain text no vars');
    });

    test('throws on undefined variable', () => {
        expect(() => resolveTemplateString('$' + '{vars.missing}', ctx)).toThrow(WorkflowValidationError);
    });

    test('throws on undefined env variable', () => {
        expect(() => resolveTemplateString('$' + '{env.NOPE}', ctx)).toThrow(WorkflowValidationError);
    });

    test('throws on undefined builtin', () => {
        expect(() => resolveTemplateString('$' + '{nope}', ctx)).toThrow(WorkflowValidationError);
    });
});

describe('resolveTemplates', () => {
    const ctx: VariableContext = {
        vars: { name: 'robin' },
        env: { SHELL: '/bin/zsh' },
        builtins: { runId: 'r99' },
    };

    test('resolves templates in plain object values', () => {
        const result = resolveTemplates(
            {
                msg: 'hi $' + '{vars.name}',
                home: '$' + '{env.SHELL}',
                id: '$' + '{runId}',
                num: 42,
                flag: true,
            },
            ctx,
        );
        expect(result).toEqual({
            msg: 'hi robin',
            home: '/bin/zsh',
            id: 'r99',
            num: 42,
            flag: true,
        });
    });

    test('resolves templates in nested objects', () => {
        const result = resolveTemplates({ outer: { inner: { val: '$' + '{vars.name}' } } }, ctx);
        expect(result).toEqual({ outer: { inner: { val: 'robin' } } });
    });

    test('resolves templates in arrays', () => {
        const result = resolveTemplates(['$' + '{vars.name}', 123, ['$' + '{env.SHELL}']], ctx);
        expect(result).toEqual(['robin', 123, ['/bin/zsh']]);
    });

    test('passes through non-string non-object non-array values', () => {
        expect(resolveTemplates(42, ctx)).toBe(42);
        expect(resolveTemplates(null, ctx)).toBeNull();
        expect(resolveTemplates(true, ctx)).toBe(true);
    });

    test('throws on undefined reference in nested value', () => {
        expect(() => resolveTemplates({ key: '$' + '{vars.missing}' }, ctx)).toThrow(WorkflowValidationError);
    });
});
