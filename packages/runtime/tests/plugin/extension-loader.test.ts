import { describe, expect, test } from 'bun:test';
import { type ExtensionRef, type LoadedExtension, loadExtensionModules } from '../../src/plugin/extension-loader';

type Kind = 'widgets';

function ref(overrides: Partial<ExtensionRef<Kind>> = {}): ExtensionRef<Kind> {
    return {
        kind: 'widgets',
        path: './ext/widget.ts',
        baseDir: '/abs',
        sourceName: 'preset-x',
        ...overrides,
    };
}

describe('loadExtensionModules', () => {
    test('no refs is a no-op and never loads or registers', async () => {
        let loaderCalls = 0;
        let registerCalls = 0;
        await loadExtensionModules<Kind>(
            [],
            {
                allowExtensions: true,
                moduleLoader: async () => {
                    loaderCalls++;
                    return {};
                },
            },
            () => {
                registerCalls++;
            },
        );
        expect(loaderCalls).toBe(0);
        expect(registerCalls).toBe(0);
    });

    test('fails closed: refs present but allowExtensions !== true throws BEFORE importing', async () => {
        let loaderCalled = false;
        const moduleLoader = async () => {
            loaderCalled = true;
            return {};
        };

        await expect(loadExtensionModules<Kind>([ref()], { moduleLoader }, () => {})).rejects.toThrow(
            'extensions are disabled',
        );
        // The single most important security invariant: no import before the gate passes.
        expect(loaderCalled).toBe(false);

        // Explicit allowExtensions: false behaves identically.
        loaderCalled = false;
        await expect(
            loadExtensionModules<Kind>([ref()], { allowExtensions: false, moduleLoader }, () => {}),
        ).rejects.toThrow('extensions are disabled');
        expect(loaderCalled).toBe(false);
    });

    test('disabled-gate error names the source, kind, and path', async () => {
        await expect(loadExtensionModules<Kind>([ref()], { moduleLoader: async () => ({}) }, () => {})).rejects.toThrow(
            '"preset-x" declares widgets extension "./ext/widget.ts"',
        );
    });

    test('loads a default export and hands it to the register callback', async () => {
        const widget = { name: 'my-widget', payload: 42 };
        const registered: Array<[ExtensionRef<Kind>, LoadedExtension]> = [];
        await loadExtensionModules<Kind>(
            [ref()],
            { allowExtensions: true, moduleLoader: async () => ({ default: widget }) },
            (r, ext) => {
                registered.push([r, ext]);
            },
        );
        expect(registered).toHaveLength(1);
        expect(registered[0]?.[1].name).toBe('my-widget');
        expect(registered[0]?.[0].kind).toBe('widgets');
    });

    test('loads a named `extension` export when there is no default', async () => {
        const ext = { name: 'named-widget' };
        let receivedName: string | undefined;
        await loadExtensionModules<Kind>(
            [ref()],
            { allowExtensions: true, moduleLoader: async () => ({ extension: ext }) },
            (_r, loaded) => {
                receivedName = loaded.name;
            },
        );
        expect(receivedName).toBe('named-widget');
    });

    test('throws when the module export lacks a string name', async () => {
        await expect(
            loadExtensionModules<Kind>(
                [ref()],
                { allowExtensions: true, moduleLoader: async () => ({ default: { notName: 1 } }) },
                () => {},
            ),
        ).rejects.toThrow('must export an object with a string "name"');
    });

    test('throws when neither default nor extension export is an object', async () => {
        await expect(
            loadExtensionModules<Kind>([ref()], { allowExtensions: true, moduleLoader: async () => ({}) }, () => {}),
        ).rejects.toThrow('must export an object with a string "name"');
    });

    test('enforces the relative-path trust guard at load time', async () => {
        await expect(
            loadExtensionModules<Kind>(
                [ref({ path: '../escape.ts' })],
                { allowExtensions: true, moduleLoader: async () => ({ default: { name: 'x' } }) },
                () => {},
            ),
        ).rejects.toThrow('".." traversal');

        await expect(
            loadExtensionModules<Kind>(
                [ref({ path: '/etc/evil.ts' })],
                { allowExtensions: true, moduleLoader: async () => ({ default: { name: 'x' } }) },
                () => {},
            ),
        ).rejects.toThrow('must be relative');
    });

    test('invokes the provided moduleLoader once per ref, in order', async () => {
        const seen: string[] = [];
        await loadExtensionModules<Kind>(
            [ref({ path: 'one.ts', baseDir: '/abs' }), ref({ path: 'two.ts', baseDir: '/abs' })],
            {
                allowExtensions: true,
                moduleLoader: async (absPath) => {
                    seen.push(absPath);
                    return { default: { name: absPath } };
                },
            },
            () => {},
        );
        expect(seen).toEqual(['/abs/one.ts', '/abs/two.ts']);
    });

    test('imports the path RESOLVED from baseDir, not a caller-supplied absolute path', async () => {
        // Security regression: the trust guard validates `path`, so the import target
        // must be derived from `path` (resolved against baseDir) — never a separately
        // supplied absolute path that could diverge from the validated one.
        let imported: string | undefined;
        await loadExtensionModules<Kind>(
            [ref({ path: 'sub/widget.ts', baseDir: '/safe/root' })],
            {
                allowExtensions: true,
                moduleLoader: async (absPath) => {
                    imported = absPath;
                    return { default: { name: 'w' } };
                },
            },
            () => {},
        );
        expect(imported).toBe('/safe/root/sub/widget.ts');
    });

    test('rejects a non-absolute baseDir', async () => {
        await expect(
            loadExtensionModules<Kind>(
                [ref({ baseDir: 'relative/dir' })],
                { allowExtensions: true, moduleLoader: async () => ({ default: { name: 'w' } }) },
                () => {},
            ),
        ).rejects.toThrow('must be an absolute directory');
    });
});
