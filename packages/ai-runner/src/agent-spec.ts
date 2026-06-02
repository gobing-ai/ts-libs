import { basename, join } from 'node:path';
import { NodeSyncFileSystem, type SyncFileSystem } from '@gobing-ai/ts-runtime';

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

export class ValueError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ValueError';
    }
}

export function validateAgentId(id: string): string {
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(id)) {
        throw new ValueError(`Invalid agent id "${id}": expected 2-64 chars, lowercase alphanumeric, "_" or "-"`);
    }
    return id;
}

export function loadAgentSpecs(configDir: string, fs: SyncFileSystem = new NodeSyncFileSystem()): AgentSpec[] {
    const entries = safeReadDir(configDir, fs)
        .filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
        .sort();
    const specs = entries.map((entry) => parseAgentSpec(fs.readFile(join(configDir, entry)), entry));
    const seen = new Set<string>();
    for (const spec of specs) {
        validateAgentId(spec.id);
        if (seen.has(spec.id)) throw new ValueError(`Duplicate agent id "${spec.id}" in ${configDir}`);
        seen.add(spec.id);
    }
    return specs;
}

export async function saveAgentSpec(
    spec: AgentSpec,
    configDir: string,
    fs: SyncFileSystem = new NodeSyncFileSystem(),
): Promise<void> {
    validateAgentId(spec.id);
    fs.mkdir(configDir);
    fs.writeFile(join(configDir, `${spec.id}.yaml`), serializeAgentSpec(spec));
}

export async function deleteAgentSpec(
    id: string,
    configDir: string,
    fs: SyncFileSystem = new NodeSyncFileSystem(),
): Promise<void> {
    validateAgentId(id);
    fs.unlink(join(configDir, `${id}.yaml`));
}

function safeReadDir(configDir: string, fs: SyncFileSystem = new NodeSyncFileSystem()): string[] {
    try {
        return fs.readDir(configDir);
    } catch {
        return [];
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
    return [
        `id: ${quoteYaml(spec.id)}`,
        `name: ${quoteYaml(spec.name)}`,
        `type: ${quoteYaml(spec.type)}`,
        `workspace: ${quoteYaml(spec.workspace)}`,
        `purpose: ${quoteYaml(spec.purpose)}`,
        `tags: [${spec.tags.map(quoteYaml).join(', ')}]`,
        ...(spec.autoStart !== undefined ? [`autoStart: ${spec.autoStart ? 'true' : 'false'}`] : []),
        'config:',
        ...serializeNestedObject(spec.config, 2),
        '',
    ].join('\n');
}

function parseYamlObject(source: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i] ?? '';
        if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
        if (raw.startsWith(' ')) continue;
        const [key, rest] = splitKeyValue(raw);
        if (rest === '') {
            const block = collectIndentedBlock(lines, i + 1);
            result[key] = parseIndentedObject(block);
            i += block.length;
        } else {
            result[key] = parseScalar(rest);
        }
    }
    return result;
}

function parseIndentedObject(lines: string[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i] ?? '';
        const trimmed = raw.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        const [key, rest] = splitKeyValue(trimmed);
        if (rest === '') {
            const nested = collectIndentedBlock(lines, i + 1).map((line) => line.replace(/^ {2}/, ''));
            result[key] = parseIndentedObject(nested);
            i += nested.length;
        } else {
            result[key] = parseScalar(rest);
        }
    }
    return result;
}

function collectIndentedBlock(lines: string[], start: number): string[] {
    const block: string[] = [];
    for (let i = start; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        if (line.trim() === '') {
            block.push(line);
            continue;
        }
        if (!line.startsWith(' ')) break;
        block.push(line.replace(/^ {2}/, ''));
    }
    return block;
}

function splitKeyValue(line: string): [string, string] {
    const index = line.indexOf(':');
    if (index < 0) throw new ValueError(`Invalid YAML line: ${line}`);
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
}

function parseScalar(value: string): unknown {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;
    if (value.startsWith('[') && value.endsWith(']')) {
        const inner = value.slice(1, -1).trim();
        return inner === '' ? [] : inner.split(',').map((part) => parseScalar(part.trim()));
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1).replaceAll('\\"', '"');
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value !== '') return numeric;
    return value;
}

function quoteYaml(value: string): string {
    return JSON.stringify(value);
}

function serializeNestedObject(value: Record<string, unknown>, indent: number): string[] {
    const prefix = ' '.repeat(indent);
    return Object.entries(value).flatMap(([key, entry]) => {
        if (Array.isArray(entry)) return [`${prefix}${key}: [${entry.map((item) => JSON.stringify(item)).join(', ')}]`];
        if (entry !== null && typeof entry === 'object') {
            return [`${prefix}${key}:`, ...serializeNestedObject(entry as Record<string, unknown>, indent + 2)];
        }
        return [`${prefix}${key}: ${typeof entry === 'string' ? quoteYaml(entry) : String(entry)}`];
    });
}

function requireString(source: Record<string, unknown>, key: keyof AgentSpec, fileName: string): string {
    const value = source[key];
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ValueError(`${basename(fileName)}: "${key}" must be a non-empty string`);
    }
    return value;
}

function requireStringArray(source: Record<string, unknown>, key: keyof AgentSpec, fileName: string): string[] {
    const value = source[key];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new ValueError(`${basename(fileName)}: "${key}" must be a string array`);
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
        throw new ValueError(`${basename(fileName)}: "${key}" must be an object`);
    }
    return value as Record<string, unknown>;
}
