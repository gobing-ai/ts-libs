import type { Logger } from '@gobing-ai/ts-infra';
import {
    basenamePath,
    createNodeFileSystem,
    dirnamePath,
    fileUrlToPath,
    normalizeSeparators,
    resolvePath,
} from '@gobing-ai/ts-runtime';
import type {
    ExtensionRef as SharedExtensionRef,
    LoadExtensionsOptions as SharedLoadExtensionsOptions,
} from '@gobing-ai/ts-runtime/extension';
import { loadExtensionModules } from '@gobing-ai/ts-runtime/extension';
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
 * Paths are resolved relative to the declaring file's directory. Use the returned
 * refs with {@link loadExtensionsIntoHost}. Rule files and presets are treated
 * identically — both flow through the same trust gate at load time.
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
            refs.push({ kind, presetName: sourceName, absPath: resolvePath(sourceDir, path) });
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

    // Normalize file:// URLs to file paths so dirname/basename produce valid
    // path components that isAbsolute() accepts (e.g. import.meta.url in tests).
    const toFilePath = (p: string): string => (p.startsWith('file://') ? fileUrlToPath(p) : p);

    // Defense-in-depth: pre-validate `..` traversal in caller-supplied absPath
    // before the basename adaptation strips it.  The shared loader's
    // assertRelativeExtensionPath also runs on the derived (basename) path.
    for (const ref of refs) {
        // Split on normalized separators: fileUrlToPath returns forward slashes on
        // every platform, so a platform SEP split would miss segments on Windows.
        const segments = normalizeSeparators(toFilePath(ref.absPath)).split('/');
        if (segments.includes('..')) {
            throw new Error(
                `extension path "${ref.absPath}" declared by "${ref.presetName}" must not contain ".." traversal`,
            );
        }
    }

    // Adapt rule-engine ExtensionRef → shared ExtensionRef so the generic loader
    // governs every import.  The shared loader resolves (baseDir, path) →
    // absPath internally; we supply dirname/basename so the resolved path
    // reconstructs the caller's original absPath.
    const sharedRefs: SharedExtensionRef<ExtensionKind>[] = refs.map((ref) => {
        const fp = toFilePath(ref.absPath);
        return {
            kind: ref.kind,
            path: `./${basenamePath(fp)}`,
            baseDir: dirnamePath(fp),
            sourceName: ref.presetName,
        };
    });

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
