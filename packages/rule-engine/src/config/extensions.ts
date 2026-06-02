import { resolve } from 'node:path';
import type { RuleEngineHost } from '../host/rule-engine-host';

/** A capability kind a preset extension can contribute. */
export type ExtensionKind = 'resolvers' | 'evaluators' | 'fixers' | 'formatters';

/** A single extension module reference, resolved to an absolute path. */
export interface ExtensionRef {
    /** Capability registry the module registers into. */
    readonly kind: ExtensionKind;
    /** Absolute path to the module to import. */
    readonly absPath: string;
    /** Name of the preset that declared this extension (for diagnostics). */
    readonly presetName: string;
}

/** Options controlling preset-extension loading. */
export interface LoadExtensionsOptions {
    /**
     * Whether to actually import extension modules. Defaults to `false`: loading
     * arbitrary code referenced by a preset is a trust decision the caller must
     * make explicitly. When refs exist and this is false, loading throws.
     */
    allowExtensions?: boolean;
    /** Optional sink for non-fatal warnings (e.g. built-in overrides). */
    logger?: { warn: (message: string) => void };
}

/** Host registries that can receive extension capabilities (fixers live on the engine, not the host). */
const HOST_REGISTRY_BY_KIND: Partial<Record<ExtensionKind, 'resolvers' | 'evaluators' | 'formatters'>> = {
    resolvers: 'resolvers',
    evaluators: 'evaluators',
    formatters: 'formatters',
};

/**
 * Collect extension refs declared by a preset's `extensions` block.
 *
 * Paths are resolved relative to the preset file's directory. Use the returned
 * refs with {@link loadExtensionsIntoHost}.
 */
export function collectPresetExtensions(
    presetName: string,
    presetDir: string,
    extensions: Partial<Record<ExtensionKind, string[] | undefined>> | undefined,
): ExtensionRef[] {
    if (extensions === undefined) return [];
    const refs: ExtensionRef[] = [];
    for (const kind of ['resolvers', 'evaluators', 'fixers', 'formatters'] as ExtensionKind[]) {
        for (const path of extensions[kind] ?? []) {
            refs.push({ kind, presetName, absPath: resolve(presetDir, path) });
        }
    }
    return refs;
}

/**
 * Import each extension module and register its export on the matching host
 * registry.
 *
 * A module must default-export (or named-export `extension`) an object with a
 * `name: string` and the capability implementation. Loading is gated by
 * {@link LoadExtensionsOptions.allowExtensions}; when refs are present but
 * loading is not allowed, this throws so the requirement is never silently dropped.
 *
 * @throws When extensions are present but `allowExtensions` is not true, or when
 *   a module cannot be imported or lacks a valid `name`.
 */
export async function loadExtensionsIntoHost(
    host: RuleEngineHost,
    refs: readonly ExtensionRef[],
    options: LoadExtensionsOptions = {},
): Promise<void> {
    if (refs.length === 0) return;
    if (options.allowExtensions !== true) {
        const first = refs[0] as ExtensionRef;
        throw new Error(
            `preset "${first.presetName}" declares ${first.kind} extension "${first.absPath}", but extensions are disabled — pass allowExtensions: true to load preset extension modules`,
        );
    }

    for (const ref of refs) {
        const moduleExports = (await import(ref.absPath)) as Record<string, unknown>;
        const candidate = moduleExports.default ?? moduleExports.extension;
        if (
            candidate === null ||
            typeof candidate !== 'object' ||
            typeof (candidate as { name?: unknown }).name !== 'string'
        ) {
            throw new Error(
                `preset "${ref.presetName}" extension "${ref.absPath}" must export an object with a string "name"`,
            );
        }
        const name = (candidate as { name: string }).name;
        const registryKey = HOST_REGISTRY_BY_KIND[ref.kind];
        if (registryKey === undefined) {
            throw new Error(`preset "${ref.presetName}" ${ref.kind} extensions are not supported`);
        }
        const registry = host[registryKey] as unknown as {
            register: (name: string, impl: unknown, origin: 'builtin' | 'extension') => void;
            has?: (name: string) => boolean;
        };
        if (options.logger && registry.has?.(name)) {
            options.logger.warn(`preset "${ref.presetName}" ${ref.kind} extension overrides existing "${name}"`);
        }
        registry.register(name, candidate, 'extension');
    }
}
