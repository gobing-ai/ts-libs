import { parse as parseYaml } from 'yaml';
import type { Config } from './config';
import { buildConfigFromObject } from './config';
import { createCfFileSystem } from './file-system-cf';
import type { ProcessExecutorConfig } from './process-executor';
import type { LoadConfigOptions, RuntimeFactory } from './runtime-factory';

/** Binding name for the YAML config text blob set in wrangler.toml. */
const CONFIG_YAML_BINDING = 'CONFIG_YAML';

/**
 * Cloudflare Workers runtime factory (no filesystem, no process execution).
 */
export const cloudflareWorkersFactory: RuntimeFactory = {
    runtimeName: 'cloudflare-workers',

    capabilities: {
        hasFilesystem: false,
        hasProcessExecution: false,
    },

    createFileSystem: () => createCfFileSystem(),

    createProcessExecutor: (_config?: ProcessExecutorConfig): never => {
        throw new Error('ProcessExecutor is not available on Cloudflare Workers.');
    },

    async loadConfig(options?: LoadConfigOptions): Promise<Config> {
        const yamlString = options?.envBindings?.[CONFIG_YAML_BINDING] as string | undefined;
        let raw: Record<string, unknown> = {};

        if (yamlString) {
            try {
                raw = parseYaml(yamlString) as Record<string, unknown>;
            } catch {
                // Fall through to schema defaults on parse failure
            }
        }

        return buildConfigFromObject(raw, options);
    },
};
