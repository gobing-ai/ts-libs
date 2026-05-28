# @gobing-ai/ts-runtime

Runtime abstractions for shared TypeScript libraries.

## Modules

- `fs`: runtime-neutral filesystem interface, Node implementation, Cloudflare stub, and file helpers.
- `process-executor`: `execa`-backed subprocess execution with structured results.
- `context`: typed runtime service registry.
- `config`: Zod-validated config builder with environment interpolation and deep merge helpers.
