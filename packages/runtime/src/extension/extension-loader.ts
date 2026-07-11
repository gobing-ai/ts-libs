import { isAbsolute, resolve } from 'node:path';
import { assertRelativeExtensionPath } from './extension-path';

/**
 * A single extension module reference.
 *
 * `kind` is an engine-defined tag the registration callback uses to route the
 * module to the right registry — the loader itself never interprets it. `path` is
 * the relative path as authored; the loader **derives** the import target by
 * resolving `path` against `baseDir` *after* validating it, so the trust guard
 * always governs the actual module that gets imported. `sourceName` identifies the
 * declaring config for diagnostics.
 */
export interface ExtensionRef<TExtensionKind extends string = string> {
    /** Engine-defined capability tag, used only by the registration callback. */
    readonly kind: TExtensionKind;
    /** Relative path as authored, enforced by {@link assertRelativeExtensionPath}. */
    readonly path: string;
    /** Absolute directory the authored `path` is resolved against. */
    readonly baseDir: string;
    /** Name of the config (preset, workflow, …) that declared this ref. */
    readonly sourceName: string;
}

/** Options controlling extension-module loading. */
export interface LoadExtensionsOptions {
    /**
     * Whether to actually import extension modules. Defaults to `false`: loading
     * arbitrary code is a trust decision the caller must make explicitly. When refs
     * exist and this is not `true`, loading throws **before any import**.
     */
    readonly allowExtensions?: boolean;
    /** Optional sink for non-fatal warnings (e.g. capability overrides). */
    readonly logger?: { warn: (message: string) => void };
    /**
     * Required module loader. The generic core never performs a dynamic `import`
     * itself — the embedder supplies the import policy (typically
     * `(absPath) => import(absPath)`), and tests pass a stub. Keeping this explicit
     * means the shared core has no ambient code-loading capability of its own.
     */
    readonly moduleLoader: (absPath: string) => Promise<Record<string, unknown>>;
    /**
     * Optional canonical-path resolver for symlink-safe confinement (ADR-022).
     *
     * When provided, the loader resolves the **real** path of the extension module
     * (following symlinks) and re-checks that it remains within `baseDir`'s real
     * root. This closes the symlink-escape vector: an authored path like
     * `extensions/legit.ts` can pass the string-level `..` guard but still point
     * outside `baseDir` via a symlink. Callers that serve extension modules from a
     * real filesystem (e.g. `createNodeFileSystem().realPath`) should supply this.
     * Stub filesystems without symlinks (e.g. CF Workers) may omit it.
     */
    readonly realPath?: (absPath: string) => string;
}

/** A validated extension module export: an object carrying at least a string `name`. */
export interface LoadedExtension {
    /** Stable name of the contributed capability bundle. */
    readonly name: string;
    /** Engine-specific contribution payload (actions, evaluators, …). */
    readonly [key: string]: unknown;
}

/**
 * Import each extension module behind an explicit trust gate, validate its export,
 * then hand it to an engine-provided registration callback.
 *
 * The loader is domain-agnostic: it does not know which registry a module belongs to.
 * It enforces the trust boundary (gate + relative-path guard), validates the
 * default/named-`extension` export shape, and delegates routing to `register`.
 *
 * Security invariants:
 * - No refs → no-op.
 * - Refs present but `allowExtensions !== true` → throws **before** any `import` or
 *   `moduleLoader` call, so a declared extension is never silently dropped.
 * - Every ref's authored path is re-validated by {@link assertRelativeExtensionPath}.
 *
 * @throws When extensions are present but `allowExtensions` is not `true`, when a path
 *   fails the trust guard, or when a module lacks a valid `name`.
 */
export async function loadExtensionModules<TExtensionKind extends string>(
    refs: readonly ExtensionRef<TExtensionKind>[],
    options: LoadExtensionsOptions,
    register: (ref: ExtensionRef<TExtensionKind>, extension: LoadedExtension) => void | Promise<void>,
): Promise<void> {
    if (refs.length === 0) return;

    // Fail closed before importing anything: a declared extension under a disabled gate
    // is a hard error, never a silent drop.
    if (options.allowExtensions !== true) {
        const first = refs[0] as ExtensionRef<TExtensionKind>;
        throw new Error(
            `"${first.sourceName}" declares ${first.kind} extension "${first.path}", but extensions are disabled — pass allowExtensions: true to load extension modules`,
        );
    }

    for (const ref of refs) {
        if (!isAbsolute(ref.baseDir)) {
            throw new Error(`"${ref.sourceName}" extension baseDir "${ref.baseDir}" must be an absolute directory`);
        }
        // Validate the authored path, then derive the import target from it so the
        // trust guard always governs the module actually imported — the loader never
        // imports a caller-supplied absolute path it did not resolve itself.
        assertRelativeExtensionPath(ref.path, { sourceName: ref.sourceName });
        const absPath = resolve(ref.baseDir, ref.path);
        // ADR-022: when realPath is available, canonicalize and re-check confinement
        // to close the symlink-escape vector — an authored path with no ".." can still
        // resolve outside baseDir via a symlink.
        if (options.realPath) {
            const realAbs = options.realPath(absPath);
            const realBase = options.realPath(ref.baseDir);
            if (realAbs !== realBase && !realAbs.startsWith(`${realBase}/`) && !realAbs.startsWith(`${realBase}\\`)) {
                throw new Error(
                    `"${ref.sourceName}" extension "${ref.path}" resolves outside baseDir via symlink (real: "${realAbs}", base: "${realBase}") — refusing to load`,
                );
            }
        }
        const moduleExports = await options.moduleLoader(absPath);
        const candidate = moduleExports.default ?? moduleExports.extension;
        if (
            candidate === null ||
            typeof candidate !== 'object' ||
            typeof (candidate as { name?: unknown }).name !== 'string'
        ) {
            throw new Error(`"${ref.sourceName}" extension "${ref.path}" must export an object with a string "name"`);
        }
        await register(ref, candidate as LoadedExtension);
    }
}
