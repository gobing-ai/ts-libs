---
template: standard
schema_version: 1
name: "ts-runtime: declare @gobing-ai/ts-db as optional peerDependency + ADR-012 note for the literal createDbAdapter import"
status: done
type: task
created_at: 2026-07-10T21:45:03.259Z
updated_at: 2026-07-10T22:24:51.880Z
---

## 0040. ts-runtime: declare @gobing-ai/ts-db as optional peerDependency + ADR-012 note for the literal createDbAdapter import

### Background
Surfaced as the one unfixed advisory of the 2026-07-10 `/sp:dev-review packages` pass (SECUA + architecture) over the working-tree diff that landed the Bun `--compile` specifier change.

**History.** Task 0037 introduced the DB seam (`RuntimeFactory.createDbAdapter` → dynamic import of `@gobing-ai/ts-db`) using a **variable** module specifier, deliberately: it kept ts-db out of the static dependency graph so tsc/bundlers never resolved it (0037 Review, SECU-1 note). The 2026-07-10 change replaced it with a **string-literal** specifier (`packages/runtime/src/runtime-node-bun.ts:48`, `await import('@gobing-ai/ts-db')`) because Bun `--compile` cannot bundle a variable specifier — it is opaque to the bundler and fails at runtime in a compiled binary.

**The gap this task closes.** The literal specifier makes the import a *direct, bundler-visible* import, but the manifest still declares `@gobing-ai/ts-db` only under `devDependencies` (`packages/runtime/package.json`). Consequences:

1. **npm consumers get no signal.** A consumer who installs `@gobing-ai/ts-runtime` from npm and calls `nodeBunFactory.createDbAdapter(...)` hits a raw `MODULE_NOT_FOUND` at runtime — nothing in the manifest tells them (or their package manager) that ts-db is required for that method.
2. **ADR-012 drift.** ADR-012 states `dependencies` track a package's **direct** `@gobing-ai/ts-*` imports. With the literal specifier this now *is* a direct import, but it cannot be a regular dependency (see constraint below) — the ADR needs a dated note sanctioning the optional-peer pattern for runtime-optional sibling imports, or the rule reads as violated.
3. **Bundler-visibility is acceptable but undocumented.** Consumer-side bundlers (esbuild/wrangler) now try to resolve the specifier. This does not newly break Cloudflare Workers bundling — the ts-runtime barrel is already node-tainted (`process-executor.ts:1-2` statically imports `node:tty` + `execa`) — but the contract ("mark it external or install it") is written nowhere.

**Hard constraint.** A regular `dependencies` entry is NOT an option: ts-db already depends on ts-runtime (`packages/db/package.json`), so a runtime→db regular dep ships a hard manifest cycle to npm and force-installs ts-db plus its drizzle peer set on every ts-runtime consumer, including Workers users who can never call the method. An **optional peerDependency** is the correct semantics: "if you call `createDbAdapter` on node-bun, install `@gobing-ai/ts-db` yourself"; metadata-only, no auto-install, cycle-tolerant.

**Publish-flow feasibility (verified 2026-07-10).** `scripts/lib/workspace-deps.ts:24` resolves `workspace:*` across all four dep fields **including `peerDependencies`** (`workspace:*` → `^<version>` at publish), so a `workspace:*` peer entry publishes correctly under the ADR-003 flow. Baseline: all packages at 0.4.5 (commit 83d80cc).
### Requirements
R1. `packages/runtime/package.json` declares `"@gobing-ai/ts-db": "workspace:*"` under `peerDependencies` with `peerDependenciesMeta: { "@gobing-ai/ts-db": { "optional": true } }`. The existing `devDependencies` entry stays (it is what makes the in-repo tests/typecheck work).

R2. ADR-012 gains a dated addendum (same style as the ADR-011 addenda) sanctioning the pattern: *a literal dynamic import of a sibling package that would create a manifest cycle as a regular dependency is declared as an optional peerDependency; the tsconfig `paths` entry still tracks it for the source closure*. Cite `runtime-node-bun.ts` createDbAdapter as the canonical instance. A change contradicting an ADR requires the ADR update to land in the same change (repo rule, `docs/00_ADR.md` preamble).

R3. The publish-time resolution of `workspace:*` inside `peerDependencies` is covered by an explicit test (extend the existing workspace-deps tests; `scripts/lib/workspace-deps.ts` DEP_FIELDS already includes `peerDependencies` — the test pins the behavior so a refactor cannot silently drop peer resolution).

R4. `nodeBunFactory.createDbAdapter` wraps the dynamic import so a missing module surfaces an actionable, typed error naming the optional peer (e.g. "install @gobing-ai/ts-db to use createDbAdapter on node-bun") instead of a raw MODULE_NOT_FOUND. Follow the existing typed-error pattern (`D1NotConfiguredError` in `packages/runtime/src/db-errors.ts`); export the new error from the package index.

R5. `packages/runtime/README.md` documents the seam contract in the DB section: ts-db is an optional peer, required only for `createDbAdapter` on node-bun; consumer bundlers must either install it or mark `@gobing-ai/ts-db` external; Workers consumers never need it (CF factory throws `D1NotConfiguredError`).

R6. Tests cover the new error path (mock/simulate import failure or assert the error type surface) and existing `create-db-adapter.test.ts` still passes; per-file coverage stays >= 90%.

R7. No regular `dependencies` entry for ts-db is added (would ship a manifest cycle + drizzle peer bloat); no change to the literal specifier itself (the Bun `--compile` motivation stands). `bun run spur-check` and `bun run build` green.
### Design

**Current state (verified 2026-07-10, v0.4.5, commit 83d80cc + working tree):**

- `packages/runtime/src/runtime-node-bun.ts:42-50` — `createDbAdapter` does `await import('@gobing-ai/ts-db')` (literal specifier; comment documents the Bun `--compile` rationale and the "ts-db is Bun/Node-only" platform exception).
- `packages/runtime/package.json` — ts-db under `devDependencies` only (`workspace:*`). No `peerDependencies` section exists yet in this package.
- `packages/runtime/tsconfig.json:6` — `paths` maps `@gobing-ai/ts-db` → `../db/src/index` (ADR-004/ADR-012 source-closure entry; unchanged by this task).
- `packages/db/package.json` — `dependencies` include `@gobing-ai/ts-runtime` (the cycle-forcing edge).
- `scripts/lib/workspace-deps.ts:24` — `DEP_FIELDS = ['dependencies','devDependencies','peerDependencies','optionalDependencies']`; `workspace:*` → `^<version>` at publish (ADR-003 flow).
- `packages/runtime/src/db-errors.ts` — existing typed-error precedent (`D1NotConfiguredError`).
- `packages/runtime/tests/create-db-adapter.test.ts` — 8 tests covering the seam (task 0037).

**Decisions:**

1. **Optional peer, not regular dep.** Peer cycles are metadata-only and npm/bun-tolerated; regular-dep cycles ship to consumers and drag drizzle peers everywhere. `peerDependenciesMeta.optional: true` prevents npm >= 7 auto-install and installer warnings for consumers who never touch the DB seam.
2. **Keep the devDependencies entry.** In-repo, the devDep is what places ts-db in the workspace install for tests; the peer entry is consumer-facing metadata. They coexist (same `workspace:*` range, both resolved at publish).
3. **Error wrapper shape.** `try { mod = await import('@gobing-ai/ts-db'); } catch (cause) { throw new DbModuleNotInstalledError(..., { cause }); }` — a new class in `db-errors.ts` alongside `D1NotConfiguredError`, message naming the package, the method, and the fix ("bun add @gobing-ai/ts-db" / mark external when bundling). Preserve `cause` for debugging. Name is a suggestion — match `db-errors.ts` naming taste at implementation time.
4. **ADR text.** Dated addendum under ADR-012 (not a new ADR): the rule "dependencies = direct imports" gains the carve-out *"unless the regular dependency would create a manifest cycle; then an optional peerDependency + tsconfig paths entry is the sanctioned form (canonical case: ts-runtime → ts-db `createDbAdapter` seam)"*.
5. **Testing the import-failure path.** Options: (a) unit-test the error class + a thin injectable import function; (b) integration-style: spawn a bun subprocess with a bare temp dir where the module genuinely cannot resolve. Prefer (a) — refactor `createDbAdapter` to accept an injectable `importFn` default-bound to the real dynamic import ONLY if it does not disturb the Bun `--compile` literal-specifier requirement (the literal must stay syntactically present for the bundler). Safe form: keep the literal `import('@gobing-ai/ts-db')` inline in the default path and test the wrapper via the thrown-error contract; do not introduce a variable specifier anywhere.

**Rejected alternatives:**

- Regular `dependencies` entry — manifest cycle shipped to npm + forced drizzle installs (see Background).
- Revert to variable specifier — reverses the Bun `--compile` motivation just landed; also restores type-dishonest casting.
- `optionalDependencies` — wrong semantics (installers attempt install and swallow failures; we want *no* install attempt).
- Do nothing — undeclared runtime contract + standing ADR-012 drift.

**Out of scope:** any change to ts-db itself; the CF/D1 path; publishing (operator-run `bun run bump-ver`).

### Plan

- [ ] Pre-flight: confirm `bun install` is clean with an optional peer cycle (runtime→db peer, db→runtime dep) — run `bun install` after the manifest edit and check for warnings/lockfile churn (R1, R7).
- [ ] `packages/runtime/package.json`: add `"peerDependencies": { "@gobing-ai/ts-db": "workspace:*" }` and `"peerDependenciesMeta": { "@gobing-ai/ts-db": { "optional": true } }`; keep the devDependencies entry (R1).
- [ ] `docs/00_ADR.md`: dated ADR-012 addendum sanctioning optional-peer + paths for cycle-forced literal dynamic imports; cite `runtime-node-bun.ts` as canonical (R2). Land in the same commit as the manifest change.
- [ ] Extend workspace-deps publish tests: a fixture manifest with a `workspace:*` peer resolves to `^<version>` (pin `DEP_FIELDS` coverage) (R3).
- [ ] `packages/runtime/src/db-errors.ts`: add the typed missing-peer error (message names package, method, and remedy; preserves `cause`) (R4).
- [ ] `packages/runtime/src/runtime-node-bun.ts`: wrap `await import('@gobing-ai/ts-db')` in try/catch, rethrow the typed error; the literal specifier stays syntactically intact for Bun --compile (R4, R7).
- [ ] `packages/runtime/src/index.ts`: export the new error class (R4).
- [ ] Tests: error class contract (name, message content, cause passthrough) + existing `create-db-adapter.test.ts` untouched-green; per-file coverage >= 90% (R6).
- [ ] `packages/runtime/README.md`: document the optional-peer seam — who needs ts-db, bundler `external` guidance, Workers exemption (R5).
- [ ] Gate: `bun run spur-check` + `bun run build` green; `git status` only intentional files (R7).
- [ ] Hand-off: next lockstep release (`bun run bump-ver`, operator-run) publishes the peer entry as `^<version>` — no separate release work in this task.

### Solution
Declare the already-real runtime contract instead of leaving it implicit: `@gobing-ai/ts-db` becomes an **optional peerDependency** of `@gobing-ai/ts-runtime` (`workspace:*` + `peerDependenciesMeta.optional: true`), the literal dynamic import in `nodeBunFactory.createDbAdapter` gets a typed, actionable missing-module error, and ADR-012 gains a dated addendum sanctioning the optional-peer + tsconfig-paths pattern for cycle-forced sibling imports.

**Boundary:** the specifier stays a string literal (Bun `--compile` contract from the 2026-07-10 change); the manifest change is metadata-only (no install-graph change for existing consumers); in-repo behavior is unchanged (devDep continues to drive workspace install).

**Change map (expected):**

- `packages/runtime/package.json:67` — add `peerDependencies` + `peerDependenciesMeta` (R1)
- `packages/runtime/src/db-errors.ts` — new typed error for missing optional peer (R4)
- `packages/runtime/src/runtime-node-bun.ts:48` — wrap the dynamic import, rethrow typed (R4)
- `packages/runtime/src/index.ts` — export the new error (R4)
- `packages/runtime/README.md` — seam contract doc (R5)
- `docs/00_ADR.md` — ADR-012 dated addendum (R2)
- `scripts/` tests — pin peerDependencies `workspace:*` publish resolution (R3)
- `packages/runtime/tests/create-db-adapter.test.ts` (or sibling) — error-path coverage (R6)
### Testing
**Verdict: PASS** — re-audit via `/sp:dev-verify 0040 --focus all --fix all --auto --force`, 2026-07-10. Fresh gate run this pass: `bun run spur-check` → 1566 pass / 0 fail, both rule presets clean (`recommended-pre-check`, `recommended-post-check` at `--fail-on warning`); `bun run build` → 8/8 packages exit 0. No fix pass needed — zero UNMET/PARTIAL, zero blocker/major findings.

**Per-requirement traceability**

| Req | Status | Evidence |
|-----|--------|----------|
| R1 optional peer + meta, devDep kept | MET | `packages/runtime/package.json:70-77` (`peerDependencies` + `peerDependenciesMeta.optional:true`), devDep retained at `:66-69`; `bun.lock` refreshed cleanly |
| R2 ADR-012 dated addendum, same change | MET | `docs/00_ADR.md` "ADR-012 Addendum — Optional peerDependency for Cycle-Forced Sibling Imports (2026-07-10)"; cites the canonical `runtime-node-bun.ts` instance; in the same working set as the manifest edit |
| R3 publish-time peer resolution pinned by test | MET | `scripts/tests/workspace-deps.test.ts` "resolves workspace ranges in peerDependencies (ADR-012 addendum)" — peer + devDep → `^0.2.0` (changed=2), `peerDependenciesMeta` asserted untouched; green in this run |
| R4 typed missing-peer error, exported | MET | `packages/runtime/src/db-errors.ts:28-36` `DbModuleNotInstalledError` (default message names package/method/remedy; `ErrorOptions` cause); wrap at `runtime-node-bun.ts:52-61` incl. export-shape guard for installed-but-incompatible ts-db; exported `packages/runtime/src/index.ts:4` |
| R5 README seam contract | MET | `packages/runtime/README.md` §8 dependency note rewritten: optional-peer rationale, who must install, bundler `external` guidance, Workers exemption, failure mode |
| R6 error-path tests, coverage >= 90% | MET | `packages/runtime/tests/create-db-adapter.test.ts` +3 tests (name/message contract, custom message, cause chaining); coverage: `db-errors.ts` 100/100, `runtime-node-bun.ts` 100 funcs / 92.59 lines (uncovered 54,58-60 = the import-failure branches, per Design decision 5) |
| R7 no regular dep; literal specifier intact | MET | `dependencies` block has no ts-db (`package.json:60-65`); literal `await import('@gobing-ai/ts-db')` at `runtime-node-bun.ts:54`; spur-check + build green |

**Acceptance Criteria Verification**

| AC | Status | Evidence Type | Evidence |
|----|--------|---------------|----------|
| (none — task has no Acceptance Criteria section; standard template, R-items are the targets) | N/A | static-ref | Requirements table above |

**Design conformance:** decisions 1-4 DONE as written; decision 5 (import-failure testing) DONE via the error-contract option (a), plus a goal-equivalent enhancement beyond the design — an export-shape guard classifying installed-but-incompatible ts-db — documented in README failure mode (CHANGED, PASS-acceptable).

**SECUA review:** no blocker/major. One minor finding (weak default-message assertion in the cause-chaining test) was fixed post-verify on 2026-07-10: `create-db-adapter.test.ts:100` now asserts `toContain('@gobing-ai/ts-db')`, pinning the default-message contract. Scope check: every diff hunk in the 0040 file set maps to R1-R7; no scope creep. (Sibling working-tree changes — `path.ts`, `extensions.ts`, `path.test.ts`, `runtime-boundaries.yaml` — belong to the prior review-fix change, verified separately in the 2026-07-10 `/sp:dev-review packages` pass.)

Coverage note: workspace-level coverage-gate rule passed; per-file thresholds met for all files touched by this task.
### References

- Task 0037 (`docs/tasks/0037_...md`) — introduced the createDbAdapter seam; its Review SECU-1 note documents the original variable-specifier decision this task's context replaces.
- `docs/00_ADR.md` — ADR-003 (publish-time caret resolution), ADR-004/ADR-012 (deps vs paths contract), ADR-011 (runtime boundary).
- 2026-07-10 `/sp:dev-review packages` findings (this session): finding #4, advisory — "Literal `import('@gobing-ai/ts-db')` is an undeclared runtime contract".
- `scripts/lib/workspace-deps.ts:24` — DEP_FIELDS includes peerDependencies; `workspace:*` → `^<version>`.
- `packages/runtime/src/runtime-node-bun.ts:42-50` — the seam + Bun --compile comment.
- npm docs: `peerDependenciesMeta.optional` — optional peers are not auto-installed and raise no warning when absent.

### History
- 2026-07-10T22:00:47.142Z backlog → todo (system)
- 2026-07-10T22:00:50.501Z todo → wip (system)
