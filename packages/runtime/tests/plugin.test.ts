import { describe, expect, test } from 'bun:test';

import * as plugin from '../src/plugin';

describe('@gobing-ai/ts-runtime plugin barrel', () => {
    test('exports CapabilityRegistry', () => {
        const registry = new plugin.CapabilityRegistry<{ execute: () => string }>('action');
        expect(registry).toBeInstanceOf(plugin.CapabilityRegistry);
    });

    test('exports assertRelativeExtensionPath', () => {
        expect(() => plugin.assertRelativeExtensionPath('/abs/path')).toThrow('must be relative');
        expect(() => plugin.assertRelativeExtensionPath('../escape')).toThrow('must not contain ".."');
        // Valid relative path does not throw.
        expect(() => plugin.assertRelativeExtensionPath('./ok.ts')).not.toThrow();
    });
});
