import {
    basenamePath,
    createNodeFileSystem,
    type FileSystem,
    joinPath,
    parseYamlObject,
    stringifyYamlObject,
} from '@gobing-ai/ts-runtime';

/** Specification for an AI agent defined in the configuration directory. */
export interface AgentSpec {
    id: string;
    name: string;
    type: string;
    workspace: string;
    purpose: string;
    tags: string[];
    config: Record<string, unknown>;
    autoStart?: boolean;
}

/** Validation error thrown when agent spec data is malformed or invalid. */
export class ValueError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ValueError';
    }
}

/** Validate that `id` matches the agent ID format: 2-64 chars, lowercase alphanumeric with `_` or `-`. Returns the id on success, throws `ValueError` otherwise. */
export function validateAgentId(id: string): string {
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(id)) {
        throw new ValueError(`Invalid agent id "${id}": expected 2-64 chars, lowercase alphanumeric, "_" or "-"`);
    }
    return id;
}

/** Load and validate all YAML agent spec files from `configDir`. Throws `ValueError` on parse failures or duplicate IDs. */
export async function loadAgentSpecs(configDir: string, fs: FileSystem = createNodeFileSystem()): Promise<AgentSpec[]> {
    const entries = (await safeReadDir(configDir, fs))
        .filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
        .sort();
    const specs = await Promise.all(
        entries.map(async (entry) => parseAgentSpec(await fs.readFile(joinPath(configDir, entry)), entry)),
    );
    const seen = new Set<string>();
    for (const spec of specs) {
        validateAgentId(spec.id);
        if (seen.has(spec.id)) throw new ValueError(`Duplicate agent id "${spec.id}" in ${configDir}`);
        seen.add(spec.id);
    }
    return specs;
}

/** Serialize `spec` to YAML and write it to `configDir/<id>.yaml`. Creates the directory if missing. */
export async function saveAgentSpec(
    spec: AgentSpec,
    configDir: string,
    fs: FileSystem = createNodeFileSystem(),
): Promise<void> {
    validateAgentId(spec.id);
    await fs.ensureDir(configDir);
    await fs.writeFile(joinPath(configDir, `${spec.id}.yaml`), serializeAgentSpec(spec));
}

/** Remove the YAML file for agent `id` from `configDir`. Does nothing if the file doesn't exist. */
export async function deleteAgentSpec(
    id: string,
    configDir: string,
    fs: FileSystem = createNodeFileSystem(),
): Promise<void> {
    validateAgentId(id);
    await fs.deleteFile(joinPath(configDir, `${id}.yaml`));
}

async function safeReadDir(configDir: string, fs: FileSystem = createNodeFileSystem()): Promise<string[]> {
    try {
        return await fs.readDir(configDir);
    } catch (error) {
        if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

function parseAgentSpec(source: string, fileName: string): AgentSpec {
    const parsed = parseYamlObject(source);
    const spec = {
        id: requireString(parsed, 'id', fileName),
        name: requireString(parsed, 'name', fileName),
        type: requireString(parsed, 'type', fileName),
        workspace: requireString(parsed, 'workspace', fileName),
        purpose: requireString(parsed, 'purpose', fileName),
        tags: requireStringArray(parsed, 'tags', fileName),
        config: requireRecord(parsed, 'config', fileName),
        ...(typeof parsed.autoStart === 'boolean' ? { autoStart: parsed.autoStart } : {}),
    };
    return spec;
}

function serializeAgentSpec(spec: AgentSpec): string {
    const record: Record<string, unknown> = {
        id: spec.id,
        name: spec.name,
        type: spec.type,
        workspace: spec.workspace,
        purpose: spec.purpose,
        tags: spec.tags,
        ...(spec.autoStart !== undefined ? { autoStart: spec.autoStart } : {}),
        config: spec.config,
    };
    return stringifyYamlObject(record);
}

function requireString(source: Record<string, unknown>, key: keyof AgentSpec, fileName: string): string {
    const value = source[key];
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ValueError(`${basenamePath(fileName)}: "${key}" must be a non-empty string`);
    }
    return value;
}

function requireStringArray(source: Record<string, unknown>, key: keyof AgentSpec, fileName: string): string[] {
    const value = source[key];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new ValueError(`${basenamePath(fileName)}: "${key}" must be a string array`);
    }
    return value;
}

function requireRecord(
    source: Record<string, unknown>,
    key: keyof AgentSpec,
    fileName: string,
): Record<string, unknown> {
    const value = source[key];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValueError(`${basenamePath(fileName)}: "${key}" must be an object`);
    }
    return value as Record<string, unknown>;
}
