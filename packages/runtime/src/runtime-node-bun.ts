import { parse as parseYaml } from 'yaml';
import type { Config } from './config';
import { buildConfigFromObject, getProcessEnv } from './config';
import type { FileSystem } from './file-system';
import { createNodeFileSystem } from './file-system-node';
import { ProcessExecutor, type ProcessExecutorConfig } from './process-executor';
import type { RuntimeFactory } from './runtime-factory';
import type { DatabaseConfig, LoadConfigOptions, RuntimeDbAdapter } from './types';

// Lazy re-initialisable singleton for test isolation.
let _nodeFileSystem: FileSystem | undefined;
function getNodeFileSystem(): FileSystem {
    if (!_nodeFileSystem) _nodeFileSystem = createNodeFileSystem();
    return _nodeFileSystem;
}

/** @internal — reset the cached filesystem (for test isolation). */
export function _resetNodeFileSystem(): void {
    _nodeFileSystem = undefined;
}

/**
 * Node.js / Bun runtime factory (filesystem, process execution, config).
 */
export const nodeBunFactory: RuntimeFactory = {
    runtimeName: 'node-bun',
    capabilities: {
        hasFilesystem: true,
        hasProcessExecution: true,
        hasPersistentStorage: true,
        hasSqlDatabase: true,
    },

    createFileSystem: () => getNodeFileSystem(),

    createProcessExecutor: (config?: ProcessExecutorConfig) => new ProcessExecutor(config),

    async loadConfig(options?: LoadConfigOptions): Promise<Config> {
        return loadNodeConfig(options);
    },

    async createDbAdapter(config: DatabaseConfig): Promise<RuntimeDbAdapter> {
        // Dynamic import via a variable specifier keeps ts-db out of the
        // static dependency graph (it depends on ts-runtime, so a static dep
        // would cycle). The variable prevents tsc from type-resolving the
        // module at build time (ts-db builds after ts-runtime); at runtime
        // Bun resolves it via the workspace + tsconfig paths. Connection only
        // — the caller owns schema/migrations.
        const moduleSpecifier = '@gobing-ai/ts-db';
        const mod = (await import(moduleSpecifier)) as {
            createDbAdapter: (config: { driver: 'bun-sqlite'; url?: string }) => RuntimeDbAdapter;
        };
        return mod.createDbAdapter({ driver: 'bun-sqlite', url: config.url });
    },
};

// ── Config loading (Node/Bun) ────────────────────────────────────────────

/**
 * Load config for Node/Bun: reads YAML from filesystem via {@link FileSystem},
 * applies env-variable interpolation, merges overrides, and validates.
 */
async function loadNodeConfig(options?: LoadConfigOptions): Promise<Config> {
    const fs = getNodeFileSystem();
    const raw = await readYamlConfig(fs);
    return buildConfigFromObject(raw ?? {}, options);
}

/**
 * Read and parse YAML config from filesystem.
 *
 * Searches common config locations in order:
 * 1. `CONFIG_PATH` env var (absolute path)
 * 2. `./config/config.yaml` (repo-local)
 * 3. `./config/config.example.yaml` (fallback)
 *
 * Returns `null` if no config file is found.
 */
async function readYamlConfig(fs: FileSystem): Promise<Record<string, unknown> | null> {
    const candidates = [getProcessEnv().CONFIG_PATH, 'config/config.yaml', 'config/config.example.yaml'].filter(
        (p): p is string => typeof p === 'string' && p.length > 0,
    );

    for (const candidate of candidates) {
        const resolved = fs.resolve(candidate);
        // Await the union-return FileSystem contract — a bare `fs.exists(...)` is always
        // truthy under an async backend, and the `readFile` Promise must be awaited rather
        // than cast to string (parity with the migrate.ts fs.exists fix).
        if (await fs.exists(resolved)) {
            const content = await fs.readFile(resolved);
            try {
                return parseYaml(content) as Record<string, unknown>;
            } catch {
                // Try next candidate on parse failure
            }
        }
    }

    return null;
}
