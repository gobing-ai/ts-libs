---
name: Product Requirements Document
doc: 01_PRD
owns: WHAT — product vision, users, scope (in / out / deferred)
authority: authoritative-on-scope
version: 1.3.0
owner: Robin Min
updated_at: 2026-10-09
read_before: adding a package or public capability
edit_rules: 99 §6.2
sync: [T1, T4, T6]
---

# Product Requirements Document

## Vision

Provide small, independently consumable TypeScript libraries for shared runtime, data, infrastructure,
AI-agent, rules, workflow, import, and browser automation concerns across Gobing applications and tools.

## Users

| User | Primary need |
|------|--------------|
| Application and tool authors | Stable typed primitives without copying infrastructure code |
| Package maintainers | Explicit boundaries, lockstep releases, and enforceable compatibility gates |

## Scope

### In scope

- Lockstep-versioned `@gobing-ai/ts-*` libraries under `packages/*`, including browser automation for dedicated authenticated profiles.
- Portable core APIs with platform-specific behavior isolated behind owning packages or adapter subpaths.
- Bun-based build, test, release, and Spur rule gates for the workspace.
- Hosted Cloudflare Clef decision backend through the existing DecisionMaker seam
  (feature A3, ADR-037), with text/JSON state and both model variants.

### Supporting

- Package READMEs, architecture decisions, generated declarations, and OIDC Trusted Publishing.
- Internal workspace dependency and TypeScript source-resolution conventions.

### Deferred

- No deferred product surface is currently committed; add it here with an explicit reactivation condition.

### Out of scope

- End-user applications, product-specific business logic, and UI components.
- Alternative package managers, runtimes, linters, or formatters for this workspace.
