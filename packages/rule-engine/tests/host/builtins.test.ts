import { describe, expect, test } from 'bun:test';
import { registerBuiltins } from '../../src/host/builtins';
import { RuleEngineHost } from '../../src/host/rule-engine-host';

describe('registerBuiltins', () => {
    test('registers all builtin evaluators', () => {
        const host = new RuleEngineHost();
        registerBuiltins(host);

        expect(host.evaluators.has('regex')).toBe(true);
        expect(host.evaluators.has('rg')).toBe(true);
        expect(host.evaluators.has('path')).toBe(true);
        expect(host.evaluators.has('file-exist')).toBe(true);
        expect(host.evaluators.has('forbidden-import')).toBe(true);
        expect(host.evaluators.has('exit-code')).toBe(true);
        expect(host.evaluators.has('secrets-scanner')).toBe(true);
        expect(host.evaluators.has('agent-detection')).toBe(true);
    });

    test('registers all builtin formatters', () => {
        const host = new RuleEngineHost();
        registerBuiltins(host);

        expect(host.formatters.has('text')).toBe(true);
        expect(host.formatters.has('json')).toBe(true);
    });
});
