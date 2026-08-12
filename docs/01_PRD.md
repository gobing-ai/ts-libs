---
name: Product Requirements Document
doc: 01_PRD
owns: WHAT — product vision, users, scope (in / out / deferred)
authority: authoritative-on-scope
version: 1.0.0
owner: Robin Min
updated_at: 2026-08-12
read_before: adding a package or public capability
edit_rules: 99 §6.2
sync: [T1, T4, T6]
---

# Product Requirements Document

## Vision

Provide small, independently consumable TypeScript libraries for shared runtime, data, infrastructure,
AI-agent, rules, workflow, and import concerns across Gobing applications and tools.

## Users

| User | Primary need |
|------|--------------|
| Application and tool authors | Stable typed primitives without copying infrastructure code |
| Package maintainers | Explicit boundaries, lockstep releases, and enforceable compatibility gates |

## Scope

### In scope

- Eight lockstep-versioned `@gobing-ai/ts-*` libraries under `packages/*`.
- Portable core APIs with platform-specific behavior isolated behind owning packages or adapter subpaths.
- Bun-based build, test, release, and Spur rule gates for the workspace.

### Supporting

- Package READMEs, architecture decisions, generated declarations, and OIDC Trusted Publishing.
- Internal workspace dependency and TypeScript source-resolution conventions.

### Deferred

- No deferred product surface is currently committed; add it here with an explicit reactivation condition.

### Out of scope

- End-user applications, product-specific business logic, and UI components.
- Alternative package managers, runtimes, linters, or formatters for this workspace.
