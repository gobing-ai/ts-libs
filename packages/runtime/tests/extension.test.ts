import { describe, expect, test } from 'bun:test';

import * as extension from '../src/extension';

describe('@gobing-ai/ts-runtime extension barrel', () => {
    test('exports CapabilityRegistry', () => {
        const registry = new extension.CapabilityRegistry<{ execute: () => string }>('action');
        expect(registry).toBeInstanceOf(extension.CapabilityRegistry);
    });

    test('exports assertRelativeExtensionPath', () => {
        expect(() => extension.assertRelativeExtensionPath('/abs/path')).toThrow('must be relative');
        expect(() => extension.assertRelativeExtensionPath('../escape')).toThrow('must not contain ".."');
        // Valid relative path does not throw.
        expect(() => extension.assertRelativeExtensionPath('./ok.ts')).not.toThrow();
    });
});
