import { parse as parseYaml } from 'yaml';
import type { Config } from './config';
import { buildConfigFromObject } from './config';
import type { FileSystem } from './file-system';
import { createNodeFileSystem } from './file-system-node';
import { ProcessExecutor, type ProcessExecutorConfig } from './process-executor';
import type { RuntimeFactory } from './runtime-factory';
import type { LoadConfigOptions } from './types';

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
    },

    createFileSystem: () => getNodeFileSystem(),

    createProcessExecutor: (config?: ProcessExecutorConfig) => new ProcessExecutor(config),

    async loadConfig(options?: LoadConfigOptions): Promise<Config> {
        return loadNodeConfig(options);
    },
};

// ── Config loading (Node/Bun) ────────────────────────────────────────────

/**
 * Load config for Node/Bun: reads YAML from filesystem via {@link FileSystem},
 * applies env-variable interpolation, merges overrides, and validates.
 */
async function loadNodeConfig(options?: LoadConfigOptions): Promise<Config> {
    const fs = getNodeFileSystem();
    const raw = readYamlConfig(fs);
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
function readYamlConfig(fs: FileSystem): Record<string, unknown> | null {
    const candidates = [process.env.CONFIG_PATH, 'config/config.yaml', 'config/config.example.yaml'].filter(
        (p): p is string => typeof p === 'string' && p.length > 0,
    );

    for (const candidate of candidates) {
        const resolved = fs.resolve(candidate);
        if (fs.exists(resolved)) {
            const content = fs.readFile(resolved) as string;
            try {
                return parseYaml(content) as Record<string, unknown>;
            } catch {
                // Try next candidate on parse failure
            }
        }
    }

    return null;
}
