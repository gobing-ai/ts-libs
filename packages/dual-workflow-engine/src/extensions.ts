import type { Logger } from '@gobing-ai/ts-infra';
import type { ExtensionRef, LoadExtensionsOptions } from '@gobing-ai/ts-runtime/extension';
import { loadExtensionModules } from '@gobing-ai/ts-runtime/extension';
import { WorkflowValidationError } from './errors';
import type { WorkflowEngineHost } from './host';
import type { ActionRunner, GuardRunner } from './types';

/** Minimal warning sink accepted for non-fatal extension diagnostics; a full {@link Logger} satisfies it. */
export type WorkflowExtensionLogger = Pick<Logger, 'warn'>;

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
 * The caller supplies the authored relative path plus the declaring directory; the
 * shared loader resolves `(baseDir, path)` and applies its traversal + symlink
 * guards to the authored string exactly as declared (task 0060 C2).
 */
export interface WorkflowExtensionRef {
    /** Target capability registry. */
    readonly kind: WorkflowExtensionKind;
    /** Relative path as authored (e.g. `./exts/foo.ts`). */
    readonly path: string;
    /** Absolute directory the authored `path` is resolved against. */
    readonly baseDir: string;
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
    readonly logger?: WorkflowExtensionLogger;
    /**
     * Required module loader seam for tests or embedders with custom import
     * policy. The shared core has no ambient code-loading capability of its
     * own; the embedder supplies the import policy.
     */
    readonly moduleLoader: (absPath: string) => Promise<Record<string, unknown>>;
    /**
     * Optional canonical-path resolver for symlink-safe confinement (ADR-022).
     * Forwarded to the shared loader. Node-facing embedders should supply
     * `createNodeFileSystem().realPath` to enable symlink-escape rejection.
     */
    readonly realPath?: (absPath: string) => string;
}

/**
 * Import each extension module behind an explicit trust gate and register
 * its actions and/or guards on the workflow host.
 *
 * Delegates generic loading (gate, path guard, module import, export
 * validation) to the shared ``loadExtensionModules`` from ts-runtime/extension,
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

    // Map 1:1 onto the shared ref shape — no dirname/basename smash, so the shared
    // loader's assertRelativeExtensionPath + realPath confinement govern the authored
    // path exactly as declared (task 0060 C2).
    const sharedRefs: ExtensionRef<WorkflowExtensionKind>[] = refs.map((ref) => ({
        kind: ref.kind,
        path: ref.path,
        baseDir: ref.baseDir,
        sourceName: ref.sourceName,
    }));

    const sharedOptions: LoadExtensionsOptions = {
        allowExtensions: options.allowExtensions,
        logger: options.logger,
        moduleLoader: options.moduleLoader,
        realPath: options.realPath,
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
    logger?: WorkflowExtensionLogger,
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
    logger?: WorkflowExtensionLogger,
): void {
    const origin = capabilityType === 'action' ? host.actionOrigin(kind) : host.guardOrigin(kind);
    if (logger && origin === 'builtin') {
        logger.warn(`"${sourceName}" extension overrides built-in ${capabilityType} "${kind}"`);
    }
}
