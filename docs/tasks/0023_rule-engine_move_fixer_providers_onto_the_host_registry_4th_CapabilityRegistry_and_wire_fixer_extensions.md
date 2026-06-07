---
name: "rule-engine: move fixer providers onto the host registry (4th CapabilityRegistry) and wire fixer extensions"
description: "rule-engine: move fixer providers onto the host registry (4th CapabilityRegistry) and wire fixer extensions"
status: Done
created_at: 2026-06-07T22:06:04.254Z
updated_at: 2026-06-07T23:30:00.000Z
folder: docs/tasks
type: task
feature-id: ""
priority: medium
estimated_hours: 5
tags: ["rule-engine","extensions","fixers","refactor","capability-registry"]
impl_progress:
  planning: done
  design: done
  implementation: done
  review: done
  testing: done
---

## 0023. "rule-engine: move fixer providers onto the host registry (4th CapabilityRegistry) and wire fixer extensions"

### Background

During Spur's `sp:spur-rules` skill/command/agent build, a capability gap surfaced: a preset (or rule
file) can declare `extensions: { fixers: [...] }`, but loading it **throws** `"… fixers extensions are
not supported"`. The other three extension kinds (`resolvers`/`evaluators`/`formatters`) load fine.
Investigation with the library author concluded the cause — *"fixers live on the engine, not the host"*
(`src/config/extensions.ts:37`) — is **an incidental inconsistency, not a valid design principle**, and
should be corrected by moving fixers onto the host as a 4th `CapabilityRegistry`.

**Why the engine-owned-fixers split is not load-bearing (verified 2026-06-07):**

- **The schema already accepts `fixers`.** `ExtensionsSchema` (`src/types.ts:252-259`) lists
  `resolvers/evaluators/fixers/formatters`; rule files gained `extensions` in task 0003. So a `fixers`
  block parses today — only loading rejects it.
- **The "fixers are host-independent" framing is already false.** `builtInFixers(host, exec)`
  (`src/fixers/fixers.ts:75`) READS `host.resolvers` to construct `TestStubFixer` — fixers already
  consume a host capability. The engine builds them by reaching into the host.
- **The structure is identical to the other three.** A fixer registry is
  `CapabilityRegistry<RuleFixerProvider>` keyed by **evaluator type** — structurally the same as
  `evaluators: CapabilityRegistry<RuleEvaluator>` keyed by evaluator type (`src/host/rule-engine-host.ts`).
- **The engine's plain `Map` is STRICTLY WEAKER than a host registry.** `RuleEngine` holds fixers as a
  private `Map<string, RuleFixerProvider>` (`src/engine.ts:36`, built at line 43, read at line 153).
  `CapabilityRegistry` (`@gobing-ai/ts-runtime/plugin/capability-registry.ts`) adds `origin`
  ('builtin'|'extension') metadata + `getEntry`/`entries` — i.e. the ability to detect and warn when an
  extension overrides a builtin. The engine `Map` cannot report that. Both are replace-by-name
  (`register` = unconditional `set`), so **neither prevents overwrite** — the hoped-for "anti-overwriting"
  benefit of the engine `Map` does not exist; it is the host registry that has the conflict-*visibility*
  feature extension loading wants.
- **The split forces a special-case.** `HOST_REGISTRY_BY_KIND` (`extensions.ts:38`) must omit `fixers`,
  so the loader throws at `extensions.ts:128-130`. Move fixers to the host and this special-case
  disappears — all four kinds flow through one uniform path and gain origin tracking for free.

**The one true fact (not a counter-argument):** `engine.applyFixes` and fix *execution* (the eval loop
calling `provider.createFixes`, then writing byte-range edits) DO belong on the engine — that is
orchestration. But this task moves the fixer **registry**, not the **executor**. The host=registry /
engine=orchestrator separation that the other three capabilities follow is exactly what makes this correct:
evaluators are also *invoked* by the engine yet *registered* on the host.

**Caller audit (resolves compat concern):** `builtInFixers` is **internal-only** — referenced solely by
`src/engine.ts` and `src/fixers/fixers.ts`; it is **NOT exported** from `packages/rule-engine/src/index.ts`.
Consumers (e.g. Spur) use only `evaluate`/`evaluateWithFixes`/`applyFixes`, never `builtInFixers` or
`engine.fixers` directly. So its signature can change without a compat shim.

**Downstream sequence:** this task lands first → release `@gobing-ai/ts-rule-engine` next version → Spur
task 0027 then consumes the released version to surface `spur rule run --fix-mode` and document fixer
extensions. Spur task 0027 R6 is the consumer side of this work.

### Requirements

## Requirements Verdict — 2026-06-07 (dev-verify re-audit)

All requirements **MET**. Evidence below; full requirement text retained in the original Requirements section above.

- [x] **R0 — Scope (registry move, not executor)** → **MET** | `applyFixes`/`evaluateWithFixes`/`min` authority untouched: `engine.ts:210 applyFixes()`, `engine.ts:216 effectiveFixMode()` byte-identical.
- [x] **R1 — host gains `fixers` registry** → **MET** | `host/rule-engine-host.ts:14,20` `readonly fixers: CapabilityRegistry<RuleFixerProvider>` = `new CapabilityRegistry('fixer')`. Import cycle avoided: `fixers.ts:16 import type` + interface moved to `types.ts:196`. Test: `tests/host/rule-engine-host.test.ts:31`.
- [x] **R2 — built-ins register into `host.fixers`** → **MET** | `fixers.ts:43 registerBuiltinFixers()` registers `regex/rg/path/file-exist/test-location` with `origin:'builtin'`; `TestStubFixer` still gets `host.resolvers`+`exec` (`fixers.ts:51-55`). Test: `tests/fixers/fixers.test.ts:388-422`.
- [x] **R3 — engine reads fixers from host** → **MET** | private Map dropped; ctor `engine.ts:40 registerBuiltinFixers(this.host,…)`; eval loop `engine.ts:150 this.host.fixers.getEntry(type)?.capability` (preserves no-provider→skip). Test: `tests/fixers/fixers.test.ts:425`.
- [x] **R4 — uniform extension-load path** → **MET** | `extensions.ts:38-43 HOST_REGISTRY_BY_KIND` total `Record` incl. `fixers:'fixers'`; line-37 false comment removed; trust gate (`extensions.ts:30,88`) unchanged. Test: `tests/config/extensions.test.ts:83`.
- [x] **R5 — keying + override semantics** → **MET** | keyed by evaluator type; override warning via `extensions.ts:137-139`. Test: `tests/config/extensions.test.ts:129-144` (override `regex` builtin → warns, origin flips).
- [x] **R6 — no schema change** → **MET** | `types.ts:284` `ExtensionsSchema.fixers` already present (task 0003); no edit; no fixers in default presets.
- [x] **R7 — tests** → **MET** | builtin regression + preset/rule-file fixer ext load + `allowExtensions:false` throws (`extensions.test.ts:119`) + override warning + no import cycle + build clean. 251 rule-engine tests green.
- [x] **R8 — docs** → **MET** | `README.md:39,723` list `fixers` as loadable kind keyed by evaluator type.

**Scope drift:** none. All 9 changed files map to R1–R8; no untraced code.


### Acceptance

- `extensions: { fixers: [...] }` in a preset OR a rule file, with `allowExtensions: true`, registers a
  custom `RuleFixerProvider` into `host.fixers` and is invoked by the eval loop for its evaluator type.
- `HOST_REGISTRY_BY_KIND` includes `fixers`; the "fixers extensions are not supported" throw is gone for
  fixers; the misleading `extensions.ts:37` comment is corrected/removed.
- Built-in fixers behave identically (regression tests green); fix execution (`applyFixes`,
  `evaluateWithFixes`, authority `min`) is unchanged.
- `allowExtensions:false` still throws for fixer refs (trust gate intact).
- `builtInFixers` signature change has no external impact (not exported); `bun run spur-check` /
  `bun run build` PASS.
- README updated; version bumped for release.

### Q&A



### Design

_(Seed notes for the design phase — exact integration points verified 2026-06-07.)_

**Files touched (4 source + tests + README):**
1. `src/host/rule-engine-host.ts` — add `fixers: CapabilityRegistry<RuleFixerProvider>` (4th registry).
2. `src/fixers/fixers.ts` — `builtInFixers` registers into `host.fixers` instead of returning a `Map`.
3. `src/engine.ts` — drop private `fixers` Map (line 36); read `this.host.fixers` in the eval loop (line 153).
4. `src/config/extensions.ts` — add `fixers: 'fixers'` to `HOST_REGISTRY_BY_KIND` (line 38); remove the
   fixers exclusion + the line-37 comment; the loader throw at 128-130 now succeeds for fixers.

**Import-cycle watch (the one real design risk):** `RuleEngineHost` (host/) would need to import
`RuleFixerProvider`. Today `RuleFixerProvider` lives in `fixers/fixers.ts`, and `builtInFixers` imports host
deps (`BuiltInFixersDeps { resolvers: CapabilityRegistry<TestPathResolver> }`). If `host` imports `fixers`
and `fixers` imports `host`, that is a cycle. Resolution options (pick at design):
- (a) Move the `RuleFixerProvider` interface (type-only) into `src/types.ts` (where `RuleEvaluator`/
  `ResultFormatter` already live and the host already imports them) — cleanest, mirrors the other three.
- (b) Keep `RuleFixerProvider` in fixers.ts but have the host import the type only (`import type`), and keep
  `builtInFixers` taking the host as a param (one-directional: fixers→host stays, host→fixers is type-only).
  Verify the bundler/tsc sees no runtime cycle.
Recommend (a): it makes fixers a first-class capability type beside evaluators/formatters/resolvers, which is
exactly the conceptual move this task makes.

**Eval-loop lookup change (preserve "no provider → skip"):** current code is
`const provider = this.fixers.get(rule.evaluator.type); if (provider) { … }` — a plain `Map.get` returns
`undefined` on miss. `CapabilityRegistry.get` THROWS on miss (`Unknown fixer: <type>`). So DO NOT swap to
`.get`; use `this.host.fixers.has(type) ? this.host.fixers.get(type) : undefined`, or
`this.host.fixers.getEntry(type)?.capability`. The latter is cleaner and one call.

**builtInFixers return shape:** today `Map<string, RuleFixerProvider>`. After: register into `host.fixers`
and return `void` (or `host` for chaining). The constructor at engine.ts:43 becomes
`builtInFixers(this.host, options.processExecutor)` with no assignment to a private field. Confirm
`builtInFixers` is not exported from index.ts (verified: it is not) — no external break.

**What does NOT change (guard against scope creep):** `applyFixes` (fixers.ts:96, engine.ts:213),
`evaluateWithFixes`, `effectiveFixMode`/`min(rule, caller)` authority, the `createFixes` provider contract,
the `allowExtensions` gate, `ExtensionsSchema` (fixers already present). This task is registry placement +
load wiring ONLY.

**Origin-tracking is the concrete win:** after R4, a fixer extension that overrides `regex`'s builtin fixer
emits the same `"… overrides existing 'regex'"` warning the host path already emits for evaluators
(extensions.ts:136-138) — impossible with the old engine `Map`. This is the capability the move unlocks, not
just symmetry.

### Solution

Moved `RuleFixerProvider`, `RuleFixerInput`, and `EffectiveFix` interfaces from `fixers/fixers.ts` to `types.ts` (resolving the import-cycle risk — mirrors how `RuleEvaluator`/`ResultFormatter` already live there). Added `fixers: CapabilityRegistry<RuleFixerProvider>` as the 4th registry on `RuleEngineHost`. Refactored `builtInFixers` → `registerBuiltinFixers(host, exec?)` that registers into `host.fixers` with `origin: 'builtin'`. Engine drops private `fixers` Map; eval loop reads `this.host.fixers.getEntry(type)?.capability` (preserving "no provider → skip" semantics). `HOST_REGISTRY_BY_KIND` now includes `fixers: 'fixers'` as a complete `Record<ExtensionKind, ...>` — the "not supported" throw for fixers is dead code. All four extension kinds flow through one uniform path with origin tracking.

Files changed (9): `types.ts`, `host/rule-engine-host.ts`, `fixers/fixers.ts`, `engine.ts`, `config/extensions.ts`, `README.md`, + 3 test files.

### Plan

- [x] Decide import-cycle resolution (moved `RuleFixerProvider` type → `src/types.ts`)
- [x] Add `fixers: CapabilityRegistry<RuleFixerProvider>` to `RuleEngineHost` (host/rule-engine-host.ts)
- [x] Refactor `builtInFixers` → `registerBuiltinFixers` into `host.fixers` (origin 'builtin'); return void
- [x] Engine: drop private `fixers` Map; constructor populates `host.fixers`; eval loop reads via `getEntry()?.capability`
- [x] `HOST_REGISTRY_BY_KIND` += `fixers: 'fixers'`; removed fixers exclusion + the line-37 comment; type now `Record` not `Partial`
- [x] Confirm `allowExtensions` gate byte-for-byte unchanged (task 0003 R6 invariant)
- [x] Tests: builtin-fixer regression; preset/rule-file fixer ext loads; `allowExtensions:false` throws; override warning; no import cycle
- [x] Update README extension section (list `fixers`, keyed by evaluator type; updated ER diagram + core concepts)
- [x] Gate: `bun run spur-check` + `bun run build` PASS; diff = host + fixers + engine + extensions + tests + README
- [ ] Bump `@gobing-ai/ts-rule-engine` version and release (operator-run)
- [ ] Hand off to Spur task 0027 (consumer)

### Review

## Review — 2026-06-07 (dev-verify re-audit, --force)

**Status:** 1 finding (P4 only)
**Scope:** task 0023 — fixer registry move + extension wiring (4 src + 3 tests + README)
**Mode:** verify (Phase 7 SECU + Phase 8 traceability)
**Channel:** inline (current)
**Gate:** `bun run spur-check` → PASS (1185 pass / 0 fail / 99.24% cov; both spur presets green) · `bun run build` → PASS (8/8 packages)
**Verdict:** PASS

### P1 — Blockers
_None._

### P2 — Warnings
_None._

### P3 — Info
_None._

### P4 — Suggestions
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | Unreachable `registryKey === undefined` throw | Usability | src/config/extensions.ts:130-132 | Dead code: `HOST_REGISTRY_BY_KIND` is a total `Record<ExtensionKind,…>` so the lookup can't be undefined. Kept intentionally as an exhaustiveness guard for the `as unknown` cast path — NOT removed (frozen file, zero measurable benefit, the throw is cheap insurance). |

**Fix-pass 2026-06-07:** 0 fixed, 0 failed, 1 skipped (P4 #1 retained by design — see recommendation).


### Testing

- 1185 tests pass, 0 fail, 99.24% line coverage across all packages
- rule-engine: 251 tests pass (including 8 new tests for fixer registry + extensions)
- New tests: builtin fixers registered with correct keys/origin, test-location conditional on processExecutor, shared provider instances, evaluateWithFixes reads from host.fixers, no-fixer evaluator skips cleanly, fixer extension loads into host.fixers, allowExtensions:false throws for fixers, fixer override warning with origin change
- `bun run spur-check` clean (Biome + typecheck + 34 pre-check rules + tests + 2 post-check rules)
- `bun run build` succeeds for all 8 packages

### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |
| code | `packages/rule-engine/src/types.ts` | lord-robb | 2026-06-07 |
| code | `packages/rule-engine/src/host/rule-engine-host.ts` | lord-robb | 2026-06-07 |
| code | `packages/rule-engine/src/fixers/fixers.ts` | lord-robb | 2026-06-07 |
| code | `packages/rule-engine/src/engine.ts` | lord-robb | 2026-06-07 |
| code | `packages/rule-engine/src/config/extensions.ts` | lord-robb | 2026-06-07 |
| docs | `packages/rule-engine/README.md` | lord-robb | 2026-06-07 |
| test | `packages/rule-engine/tests/fixers/fixers.test.ts` | lord-robb | 2026-06-07 |
| test | `packages/rule-engine/tests/config/extensions.test.ts` | lord-robb | 2026-06-07 |
| test | `packages/rule-engine/tests/host/rule-engine-host.test.ts` | lord-robb | 2026-06-07 |

### References

- Design seed notes in task file verified against live code 2026-06-07
- Import-cycle resolution: option (a) from design — move interfaces to `types.ts`
