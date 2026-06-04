# @gobing-ai/ts-runtime

Runtime abstraction layer — platform detection, file system, process execution, configuration,
context management, path utilities, and a shared plugin/capability core. Works on Node.js, Bun,
and Cloudflare Workers through a factory pattern that auto-detects the runtime.

## Subpaths

| Import path | What it provides |
|-------------|-----------------|
| `@gobing-ai/ts-runtime` | Core: factory, FileSystem, ProcessExecutor, Config, Context, path utilities |
| `@gobing-ai/ts-runtime/plugin` | Shared plugin core: CapabilityRegistry, extension loader, path guard |

## Quick start

```ts
// Auto-detect platform and wire services
import { createRuntimeContextFromFactory } from '@gobing-ai/ts-runtime';

const ctx = await createRuntimeContextFromFactory();
const fs = ctx.require('fileSystem');
const config = ctx.require('config');

console.log(config.app.port);     // 3000 (from config.yaml or defaults)
console.log(fs.getProjectRoot()); // /Users/you/project
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│     createRuntimeContextFromFactory()            │
│            (async entry point)                   │
├─────────────────────────────────────────────────┤
│  loadRuntimeFactory()                            │
│   ├── isCloudflareWorkerRuntime()?               │
│   │    → cloudflareWorkersFactory                │
│   │    → nodeBunFactory                          │
│   ├── factory.loadConfig()         → Config      │
│   ├── factory.createFileSystem()   → FileSystem  │
│   └── factory.createProcessExecutor() → ProcessExecutor │
└─────────────────────────────────────────────────┘
```

## Core modules

### 1. Runtime detection + factory

Single entry point — `loadRuntimeFactory()` detects the platform and returns the right factory:

```ts
import { isCloudflareWorkerRuntime, loadRuntimeFactory, _resetRuntimeFactory } from '@gobing-ai/ts-runtime';

isCloudflareWorkerRuntime();  // checks globalThis.navigator?.userAgent

const factory = await loadRuntimeFactory();
factory.runtimeName;          // 'node-bun' or 'cloudflare-workers'
factory.capabilities;         // { hasFilesystem: true, hasProcessExecution: true }

factory.createFileSystem();
factory.createProcessExecutor();
await factory.loadConfig();

// Test isolation:
_resetRuntimeFactory();
```

### 2. Context (service locator)

```ts
import { createRuntimeContextFromFactory, createRuntimeContext } from '@gobing-ai/ts-runtime';

// Auto-wired (async, recommended):
const ctx = await createRuntimeContextFromFactory();
ctx.require('fileSystem').getProjectRoot();

// Manual (sync, deprecated — kept for backward compatibility):
const ctx2 = createRuntimeContext({
    runtimeName: 'node-bun',
    services: { fileSystem: new NodeFileSystem() },
});
```

### 3. File system

Two implementations behind a single interface:

```ts
import { createNodeFileSystem, createCfFileSystem } from '@gobing-ai/ts-runtime';

// Node.js / Bun — real filesystem (sync node:fs)
const fs = createNodeFileSystem('/path/to/project');
fs.readFile('src/index.ts');       // string
fs.writeFile('out.txt', 'hello');  // void
fs.exists('package.json');         // boolean
fs.ensureDir('tmp/cache');         // recursive mkdir
fs.stat('package.json');           // { isFile, isDirectory, size, mtimeMs } | null

// Cloudflare Workers — stub (throws on mutating ops)
const cffs = createCfFileSystem();
cffs.getProjectRoot();   // '/bundle'
cffs.readFile('/x');     // throws: "use D1, KV, or R2"
```

Old APIs (`NodeFileSystem`, `CloudflareFileSystem`, `NodeSyncFileSystem`, `SyncFileSystem`,
`setFileSystem`, `getFs`) are marked `@deprecated` — use `createNodeFileSystem()` or
the factory instead.

### 4. Process execution

Single class wrapping `execa` for buffered execution and `Bun.spawn` for streaming:

```ts
import { ProcessExecutor } from '@gobing-ai/ts-runtime';

const exec = new ProcessExecutor({ defaultTimeout: 30_000 });

// Buffered — captures stdout/stderr, no throw on non-zero
const result = await exec.run({
    command: 'git',
    args: ['status', '--short'],
    cwd: '/path/to/repo',
});
result.exitCode;   // 0
result.stdout;     // 'M src/index.ts\n'
result.stderr;     // ''
result.durationMs; // 42

// Streaming — interactive subprocess with stdin control
const proc = exec.runStreaming({ command: 'cat', args: [] });
proc.writeStdin('hello\n');
proc.endStdin();
const exitCode = await proc.exited; // 0
```

`rejectOnError: true` throws on non-zero exits. `OutputPolicy` controls
buffered vs streamed output. `ProcessOptions` supports timeout, env, cwd,
maxOutput, and window label.

Old APIs (`NodeProcessExecutor`, `BunSyncProcessExecutor`, `BunPipeProcessSpawner`,
`SyncProcessExecutor`, `PipeProcessSpawner`) are marked `@deprecated`.

### 5. Path utilities

Runtime-portable path math — zero `node:*` imports. Works on Cloudflare Workers.

```ts
import {
    SEP,
    basenamePath,
    dirnamePath,
    isAbsolutePath,
    joinPath,
    normalizeSeparators,
    relativePath,
    resolvePath,
    getProcessCwd,
} from '@gobing-ai/ts-runtime';

normalizeSeparators('C:\\Users\\x\\file.ts'); // 'C:/Users/x/file.ts'
SEP;                                          // '/' on POSIX, '\\' on Windows
isAbsolutePath('/abs');                       // true
basenamePath('/a/b/c.ts');                    // 'c.ts'
basenamePath('/a/b/c.ts', '.ts');            // 'c'
dirnamePath('/a/b/c.ts');                     // '/a/b'
joinPath('/a', 'b', 'c');                     // '/a/b/c'
resolvePath('/a/b', '../c');                  // '/a/c'
relativePath('/a/x', '/a/y');                 // '../y'
getProcessCwd();                              // process.cwd() or '/' on Workers
```

### 6. Configuration

YAML config loading with env-var interpolation and Zod validation:

```ts
import { buildConfigFromYaml, buildConfigFromObject } from '@gobing-ai/ts-runtime';

const yaml = `
app:
  name: my-app
  env: development
  port: $APP_PORT
`;
const config = buildConfigFromYaml(yaml, { env: { APP_PORT: '8080' } });
```

Config schema: `app.name`, `app.env` (`development`|`staging`|`production`|`test`),
`app.port` (3000 default). `buildConfigFromObject` accepts raw objects with the
same interpolation + validation.

### 7. Structured config + JSON-Schema validation

For config files that declare a `$schema` field, `loadStructuredConfig` and
`parseStructuredConfig` validate the document against its declared JSON Schema
before returning:

```ts
import { loadStructuredConfig } from '@gobing-ai/ts-runtime';

const { config, schemaUri } = loadStructuredConfig<MyConfig>('config/app.yaml', {
    schemaLoaders: { 'my-schema': mySchemaLoader },
});
```

Supports `$comment`-in-schema YAML references (`.` not in property names).

### 8. Runtime types

```ts
import type {
    RuntimeName,           // 'node-bun' | 'cloudflare-workers'
    RuntimeCapabilities,   // { hasFilesystem, hasProcessExecution }
    LoadConfigOptions,     // { overrides?, envBindings? }
} from '@gobing-ai/ts-runtime';
```

## Plugin core (`@gobing-ai/ts-runtime/plugin`)

Domain-agnostic capability registry and trust-gated extension loader used by
both `ts-rule-engine` and `ts-dual-workflow-engine`.

### CapabilityRegistry

```ts
import { CapabilityRegistry } from '@gobing-ai/ts-runtime/plugin';

const registry = new CapabilityRegistry<Widget>('widget');
registry.register('core', coreWidget, 'builtin');
registry.register('ext',  extWidget,  'extension');

registry.has('core');             // true
registry.get('core').execute();   // ok
registry.get('missing');          // throws: Unknown widget: missing
registry.getEntry('core')?.origin; // 'builtin'
registry.list();                  // ['core', 'ext'] (insertion order)
```

### Extension loading (trust-gated)

```ts
import { loadExtensionModules } from '@gobing-ai/ts-runtime/plugin';

// Throws before any import unless allowExtensions is true.
await loadExtensionModules(refs, { allowExtensions: true, moduleLoader: (p) => import(p) }, register);
```

`moduleLoader` is required — the shared core has no ambient `import()` capability.
The loader validates both default and named `extension` exports. Invalid modules
throw with source name, kind, and path context.

### Path guard

```ts
import { assertRelativeExtensionPath } from '@gobing-ai/ts-runtime/plugin';

assertRelativeExtensionPath('./ext/my.ts');  // ok
assertRelativeExtensionPath('/etc/evil.ts'); // throws: must be relative
assertRelativeExtensionPath('../escape.ts'); // throws: must not contain ".."
```

## Cloudflare Workers

```ts
import { cloudflareWorkersFactory } from '@gobing-ai/ts-runtime';

const factory = cloudflareWorkersFactory;
factory.capabilities.hasFilesystem;        // false
factory.capabilities.hasProcessExecution;  // false
factory.createProcessExecutor();           // throws
factory.createFileSystem();                // stub: getProjectRoot(), resolve()

// Config from a wrangler.toml CONFIG_YAML text blob:
await factory.loadConfig({
    envBindings: { CONFIG_YAML: yamlString },
});
```

## Graceful disposal

```ts
ctx.dispose(); // calls dispose() on every registered service that implements it
```

## Reference table

| Concept | Node/Bun | Cloudflare Workers |
|---------|----------|-------------------|
| File system | `createNodeFileSystem()` — real fs | `createCfFileSystem()` — stub (throws; use D1/KV/R2) |
| Process execution | `ProcessExecutor` — execa + Bun.spawn | throws `ProcessExecutor is not available` |
| Config loading | YAML on filesystem | CONFIG_YAML text blob + env overlay |
| Path utilities | All functions work | All functions work (zero `node:*` deps) |
| Runtime detection | `isCloudflareWorkerRuntime()` → false | `isCloudflareWorkerRuntime()` → true |
| Factory | `nodeBunFactory` | `cloudflareWorkersFactory` |
