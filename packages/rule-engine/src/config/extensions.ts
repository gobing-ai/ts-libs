import type { Logger } from '@gobing-ai/ts-infra';
import { createNodeFileSystem } from '@gobing-ai/ts-runtime';
import type {
    ExtensionRef as SharedExtensionRef,
    LoadExtensionsOptions as SharedLoadExtensionsOptions,
} from '@gobing-ai/ts-runtime/extension';
import { loadExtensionModules } from '@gobing-ai/ts-runtime/extension';
import type { RuleEngineHost } from '../host/rule-engine-host';
/** A capability kind a preset extension can contribute. */
export type ExtensionKind = 'resolvers' | 'evaluators' | 'fixers' | 'formatters';

/**
 * A single extension module reference: the authored relative path plus the
 * declaring directory (task 0060 C2). Keeping the authored string means the
 * shared loader's `assertRelativeExtensionPath` sees the real declaration — a
 * `..` segment or absolute path is rejected there, not after a basename smash
 * has already stripped it.
 */
export interface ExtensionRef {
    /** Capability registry the module registers into. */
    readonly kind: ExtensionKind;
    /** Relative path as authored (e.g. `./exts/foo.ts`). */
    readonly path: string;
    /** Absolute directory the authored `path` is resolved against. */
    readonly baseDir: string;
    /** Name of the preset that declared this extension (for diagnostics). */
    readonly sourceName: string;
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
    logger?: Pick<Logger, 'warn'>;
    /** Optional module loader seam for tests or embedders with custom import policy. */
    moduleLoader?: (absPath: string) => Promise<Record<string, unknown>>;
    /**
     * Optional canonical-path resolver for symlink-safe confinement (ADR-022).
     * Forwarded to the shared loader. Defaults to the node filesystem's
     * canonicalizer whenever the default (real dynamic-import) `moduleLoader` is
     * in effect, so a symlink inside the declaring directory cannot escape it.
     * Pass `realPath: undefined` explicitly to opt out (e.g. pnpm/Nix symlinked
     * layouts), or supply a custom resolver. When a custom `moduleLoader` is
     * given, confinement policy is caller-owned and no default applies.
     */
    realPath?: (absPath: string) => string;
}

/** Host registries that can receive extension capabilities (all four kinds). */
const HOST_REGISTRY_BY_KIND: Record<ExtensionKind, 'resolvers' | 'evaluators' | 'fixers' | 'formatters'> = {
    resolvers: 'resolvers',
    evaluators: 'evaluators',
    fixers: 'fixers',
    formatters: 'formatters',
};

/**
 * Collect extension refs declared by a preset's or rule file's `extensions` block.
 *
 * Paths are kept **as authored** and paired with the declaring file's directory as
 * `baseDir` — no eager resolution, so the shared loader's traversal guard sees the
 * real declaration (task 0060 C2). Use the returned refs with
 * {@link loadExtensionsIntoHost}. Rule files and presets are treated identically —
 * both flow through the same trust gate at load time.
 */
export function collectExtensions(
    sourceName: string,
    sourceDir: string,
    extensions: Partial<Record<ExtensionKind, string[] | undefined>> | undefined,
): ExtensionRef[] {
    if (extensions === undefined) return [];
    const refs: ExtensionRef[] = [];
    for (const kind of ['resolvers', 'evaluators', 'fixers', 'formatters'] as ExtensionKind[]) {
        for (const path of extensions[kind] ?? []) {
            refs.push({ kind, sourceName, path, baseDir: sourceDir });
        }
    }
    return refs;
}

/**
 * Import each extension module and register its export on the matching host
 * registry.
 *
 * Delegates generic loading (trust gate, path guard, module import, export-shape
 * validation) to the shared ``loadExtensionModules`` from ts-runtime/extension, then
 * routes each capability to the correct host registry based on ``ref.kind``.
 *
 * A module must default-export (or named-export ``extension``) an object with a
 * ``name: string`` and the capability implementation. Loading is gated by
 * {@link LoadExtensionsOptions.allowExtensions}; when refs are present but
 * loading is not allowed, this throws so the requirement is never silently dropped.
 *
 * @throws When extensions are present but ``allowExtensions`` is not true, or when
 *   a module cannot be imported or lacks a valid ``name``.
 */
export async function loadExtensionsIntoHost(
    host: RuleEngineHost,
    refs: readonly ExtensionRef[],
    options: LoadExtensionsOptions = {},
): Promise<void> {
    if (refs.length === 0) return;

    // Map 1:1 onto the shared ref shape — no dirname/basename smash, so the shared
    // loader's assertRelativeExtensionPath + realPath confinement govern the authored
    // path exactly as declared (task 0060 C2).
    const sharedRefs: SharedExtensionRef<ExtensionKind>[] = refs.map((ref) => ({
        kind: ref.kind,
        path: ref.path,
        baseDir: ref.baseDir,
        sourceName: ref.sourceName,
    }));

    const moduleLoader = options.moduleLoader ?? defaultModuleLoader;
    // Real import policy gets real confinement by default (ADR-022 addendum): a
    // caller relying on the default dynamic-import loader that has not set
    // `realPath` — even explicitly to undefined — gets node canonicalization, so a
    // symlink inside the declaring directory cannot escape it. A custom
    // moduleLoader owns its confinement policy; no default applies there.
    const realPath =
        'realPath' in options ? options.realPath : options.moduleLoader === undefined ? defaultRealPath() : undefined;
    const sharedOptions: SharedLoadExtensionsOptions = {
        allowExtensions: options.allowExtensions,
        logger: options.logger,
        moduleLoader,
        realPath,
    };

    await loadExtensionModules<ExtensionKind>(sharedRefs, sharedOptions, async (sharedRef, extension) => {
        const name = extension.name as string;
        const registryKey = HOST_REGISTRY_BY_KIND[sharedRef.kind];
        if (registryKey === undefined) {
            throw new Error(`"${sharedRef.sourceName}" ${sharedRef.kind} extensions are not supported`);
        }
        const registry = host[registryKey] as unknown as {
            register: (name: string, impl: unknown, origin: 'builtin' | 'extension') => void;
            has?: (name: string) => boolean;
        };
        if (options.logger && registry.has?.(name)) {
            options.logger.warn(`"${sharedRef.sourceName}" ${sharedRef.kind} extension overrides existing "${name}"`);
        }
        registry.register(name, extension, 'extension');
    });
}

async function defaultModuleLoader(absPath: string): Promise<Record<string, unknown>> {
    return (await import(absPath)) as Record<string, unknown>;
}

function defaultRealPath(): (absPath: string) => string {
    const fs = createNodeFileSystem();
    return (absPath) => (fs.realPath ? fs.realPath(absPath) : absPath);
}
