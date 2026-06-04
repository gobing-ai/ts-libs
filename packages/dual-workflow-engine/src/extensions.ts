import { basenamePath, dirnamePath, SEP } from '@gobing-ai/ts-runtime';
import type { ExtensionRef, LoadExtensionsOptions } from '@gobing-ai/ts-runtime/plugin';
import { loadExtensionModules } from '@gobing-ai/ts-runtime/plugin';
import { WorkflowValidationError } from './errors';
import type { WorkflowEngineHost } from './host';
import type { ActionRunner, GuardRunner } from './types';

/**
 * Capability kinds a workflow extension module can contribute.
 *
 * Only `actions` and `guards` are supported as extension surfaces. Driver,
 * loader, validator, and formatter registries are explicitly deferred per
 * ADR-010 and are not extension-loadable.
 */
export type WorkflowExtensionKind = 'actions' | 'guards';

/**
 * A single workflow extension module reference.
 *
 * The caller provides a pre-resolved absolute path; the loader adapts it to the
 * shared `ExtensionRef` format before delegating to the generic core so the
 * trust guard always governs the module that gets imported.
 */
export interface WorkflowExtensionRef {
    /** Target capability registry. */
    readonly kind: WorkflowExtensionKind;
    /** Absolute path to the module to import. */
    readonly absPath: string;
    /** Name of the config declaring this extension (for diagnostics). */
    readonly sourceName: string;
}

/** Options controlling workflow extension loading. */
export interface LoadWorkflowExtensionsOptions {
    /**
     * Whether to actually import extension modules. Defaults to `false`:
     * loading arbitrary code is a trust decision the caller must make
     * explicitly. When refs exist and this is not `true`, loading throws
     * **before any import**.
     */
    readonly allowExtensions?: boolean;
    /** Optional sink for non-fatal warnings (e.g. built-in overrides). */
    readonly logger?: { warn: (message: string) => void };
    /**
     * Required module loader seam for tests or embedders with custom import
     * policy. The shared core has no ambient code-loading capability of its
     * own; the embedder supplies the import policy.
     */
    readonly moduleLoader: (absPath: string) => Promise<Record<string, unknown>>;
}

/**
 * Import each extension module behind an explicit trust gate and register
 * its actions and/or guards on the workflow host.
 *
 * Delegates generic loading (gate, path guard, module import, export
 * validation) to the shared ``loadExtensionModules`` from ts-runtime/plugin,
 * then routes each capability to ``host.registerAction`` or
 * ``host.registerGuard`` based on ``ref.kind``.
 *
 * @throws When extensions are present but ``allowExtensions`` is not ``true``,
 *   when a module lacks a valid export shape, or when the module's export
 *   does not contain entries matching ``ref.kind``.
 */
export async function loadWorkflowExtensionsIntoHost(
    host: WorkflowEngineHost,
    refs: readonly WorkflowExtensionRef[],
    options: LoadWorkflowExtensionsOptions,
): Promise<void> {
    if (refs.length === 0) return;

    // Enforce relative-path guard before adapting to the shared format.
    // The shared loader's assertRelativeExtensionPath applies to the derived
    // (basename) path, which is always clean — this pre-check catches `..`
    // traversal in the caller-supplied absPath before basename strips it (R6).
    for (const ref of refs) {
        const segments = ref.absPath.split(SEP);
        if (segments.includes('..')) {
            throw new Error(
                `extension path "${ref.absPath}" declared by "${ref.sourceName}" must not contain ".." traversal`,
            );
        }
    }

    // Adapt WorkflowExtensionRef → shared ExtensionRef so the generic loader
    // governs every import.  The shared loader resolves (baseDir, path) ->
    // absPath internally; we supply dirname/basename so the resolved path
    // reconstructs the caller's original absPath.  assertRelativeExtensionPath
    // is satisfied because basenamePath() is always a simple filename.
    const sharedRefs: ExtensionRef<WorkflowExtensionKind>[] = refs.map((ref) => ({
        kind: ref.kind,
        path: `./${basenamePath(ref.absPath)}`,
        baseDir: dirnamePath(ref.absPath),
        sourceName: ref.sourceName,
    }));

    const sharedOptions: LoadExtensionsOptions = {
        allowExtensions: options.allowExtensions,
        logger: options.logger,
        moduleLoader: options.moduleLoader,
    };

    await loadExtensionModules<WorkflowExtensionKind>(sharedRefs, sharedOptions, async (sharedRef, extension) => {
        await registerExtensionOnHost(host, sharedRef, extension, options.logger);
    });
}

/**
 * Route extension-exported capabilities to the correct host registry.
 *
 * Validates that the module export contains entries matching `ref.kind`
 * (wrong-kind-for-ref throws ``WorkflowValidationError``), registers each
 * with origin ``'extension'``, and warns on built-in overrides.
 */
async function registerExtensionOnHost(
    host: WorkflowEngineHost,
    ref: ExtensionRef<WorkflowExtensionKind>,
    extension: Record<string, unknown>,
    logger?: { warn: (message: string) => void },
): Promise<void> {
    const name = extension.name as string;

    if (ref.kind === 'actions') {
        const actions = extension.actions as readonly ActionRunner[] | undefined;
        if (!Array.isArray(actions)) {
            throw new WorkflowValidationError(
                `"${ref.sourceName}" extension "${name}" is referenced as kind "actions" but does not export an actions[] array`,
            );
        }
        for (const action of actions) {
            warnIfOverride(host, action.kind, 'action', ref.sourceName, logger);
            host.registerAction(action, 'extension');
        }
    } else {
        const guards = extension.guards as readonly GuardRunner[] | undefined;
        if (!Array.isArray(guards)) {
            throw new WorkflowValidationError(
                `"${ref.sourceName}" extension "${name}" is referenced as kind "guards" but does not export a guards[] array`,
            );
        }
        for (const guard of guards) {
            warnIfOverride(host, guard.kind, 'guard', ref.sourceName, logger);
            host.registerGuard(guard, 'extension');
        }
    }
}

function warnIfOverride(
    host: WorkflowEngineHost,
    kind: string,
    capabilityType: 'action' | 'guard',
    sourceName: string,
    logger?: { warn: (message: string) => void },
): void {
    const origin = capabilityType === 'action' ? host.actionOrigin(kind) : host.guardOrigin(kind);
    if (logger && origin === 'builtin') {
        logger.warn(`"${sourceName}" extension overrides built-in ${capabilityType} "${kind}"`);
    }
}
