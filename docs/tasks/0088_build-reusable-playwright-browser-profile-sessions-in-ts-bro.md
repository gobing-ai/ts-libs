---
schema_version: 1
name: Build reusable Playwright browser profile sessions in ts-browser-automation
status: done
template: standard
created_at: 2026-09-27T04:10:31.948Z
updated_at: "2026-09-27T17:36:01.525Z"

feature_id: M
ac_numbering: task-local
estimate_hours: 12
---

## 0088. Build reusable Playwright browser profile sessions in ts-browser-automation

### Background

The knowledge-kit E8 XHS script driver currently obtains a persistent Chromium context through `packages/publish-harness/src/index.ts:307` and reuses `~/.config/kk/browser-profiles/<channel>`. Its caller casts the returned context from `unknown`, picks a page, and closes the context (`plugins/publishings/xhs-pub/src/index.ts:303-326`). The general lifecycle belongs in a separately published ts-libs package so other projects can use dedicated profiles. Playwright documents that the user-data directory stores session state and cannot be opened by concurrent browser instances. It also warns against automating a user's regular Chrome profile. This task creates one reusable package; knowledge-kit migration is a separate downstream task.

Decision: name the package `@gobing-ai/ts-browser-automation` (`packages/browser-automation`) instead of `ts-web-tools`; its scope is browser sessions, not arbitrary web utilities. New package design must follow ts-libs ADR-001/002/003/004/011/012 and `docs/PACKAGE_RELEASE.md`. Add a dated ADR for the browser adapter's platform API ownership and Playwright dependency strategy before implementing a cross-package boundary.

### Requirements

- [x] R1. Add a public, independently buildable `@gobing-ai/ts-browser-automation` workspace package with typed exports, README, package metadata, lockstep current version, and the repository's build/typecheck/test/release conventions. Use `@gobing-ai/ts-runtime` for generic filesystem/path/process operations where it covers the need; explicitly document any narrow browser adapter exception in an ADR. Do not change the release workflow.
- [x] R2. Provide a headed Chromium login operation that accepts an explicit dedicated `profileDir`, a login URL, an application-owned async `isAuthenticated(page)` predicate, and a finite timeout. It opens a visible browser, allows the user to sign in on the site, reports success only after the predicate passes, and closes the context on success, timeout, cancellation, or error. Never collect plaintext passwords or infer authentication from profile existence.
- [x] R3. Provide a typed low-level persistent-context opener plus a scoped callback helper for later automation: accept the same `profileDir`, open a Playwright `BrowserContext`/`Page`, run caller actions, and close the scoped helper in `finally`. Require a caller-owned readiness predicate before claiming an authenticated session; on expiry, fail with a recoverable re-login instruction. The callback has normal Playwright page/locator/file upload APIs and access to Chromium CDP via the context for caller-owned cases such as XHS's closed-shadow control.
- [x] R4. Treat the profile as sensitive session material: create a dedicated directory with owner-only access on supported local filesystems, do not copy/export cookies into logs or repository files, reject empty/invalid profile paths, and fail clearly on a profile already in use. A headless run against a missing profile must fail instead of silently creating an unauthenticated one. Existing profile directories are adopted in place without moving or deleting their contents.
- [x] R5. Keep app-specific choices outside the package: no `~/.config/kk` default, channel registry, site selectors, CAPTCHA bypass, publishing workflow, draft/public switch, or synthetic success result. The package has no browser side effect at module import time.
- [x] R6. Document install/runtime requirements, headed login → headless reuse example, profile sensitivity, single-process profile rule, auth expiry, and the fact that some sites may reject headless automation. Exercise lifecycle and failure cases using a fake launcher plus one manual local smoke recipe; no live account or credentials in automated tests.

### Acceptance Criteria

- [x] AC1 — A user can sign in once with a dedicated visible browser profile (req: R2, R4)
- [x] AC2 — An authenticated profile can drive a later headless browser callback (req: R3)
- [x] AC3 — Missing, busy, expired, and timed-out profiles fail without a false authenticated result (req: R2, R3, R4)
- [x] AC4 — The browser package builds and loads independently of knowledge-kit (req: R1, R5, R6)

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-09-27T04:11:07.881Z

- Package name: `ts-browser-automation` describes the browser-specific scope more precisely than `ts-web-tools`.
- Login artifact: the persistent profile directory is the session state; no separate password vault or `storageState` JSON is introduced.
- Auth success: only the caller's predicate can establish site readiness. Library-level file existence is insufficient.
- CDP boundary: expose typed Playwright context/page; the consumer owns site-specific CDP commands.
- Playwright version: required peer `^1.55.0`, matching knowledge-kit's current `1.55.0` development dependency; the package uses type-only imports and a runtime-lazy loader for clear failure messages.
- Publication: build/package documentation is in scope; version bump, tag push, and npm publish are operator release steps after implementation and verification.

### Design

Offer a small typed API: `openPersistentBrowser({ profileDir, headless })` returning a Playwright `BrowserContext`, `loginWithProfile({ profileDir, url, isAuthenticated, timeoutMs, signal? })`, and `withProfilePage({ profileDir, headless, url?, isAuthenticated?, signal? }, callback)`. All three use one launcher; `withProfilePage` provides `{ context, page }` and guarantees context closure. The low-level opener lets existing consumers retain their own `finally` lifetime. The login helper runs headed and polls the site-owned predicate. Headless reuse checks for an existing profile before launch; its auth claim depends on the predicate, not on filesystem state. The launcher's Playwright import is runtime-lazy with a clear missing-package/browser error, while public types are genuine Playwright types. Use `playwright` as a required peer at `^1.55.0` and a dev dependency pinned to the current knowledge-kit version `1.55.0`; consumers own the browser install. Record this in the ADR and README. Do not introduce a page command DSL: the callback already exposes the Playwright surface XHS needs.

The package never stores a username/password. Playwright's user-data directory stores cookies and local storage; `storageState` is a separate optional future use case, not part of this task. `connectOverCDP` is also deferred: XHS only needs `context.newCDPSession(page)` after the package launches the browser. Preserve the ability to run headed for debugging and a later headless invocation using the same profile, but do not promise headless success on every site.

### Plan

1. Record the package/dependency/platform-boundary ADR and add the workspace package using an adjacent package's manifest, tsconfig, build, and README conventions. Ensure direct internal dependencies use `workspace:*` plus source `paths` where required.
2. Implement one internal persistent launcher and the three public operations. Keep `profileDir` explicit and resolve it to an absolute path. Establish directory owner permissions on creation; use no credential export or logging. Close the context in all scoped exits and surface missing Playwright/Chromium, concurrent use, expired auth, timeout, and cancellation distinctly.
3. Add focused fake-launcher tests for headed options, profile-dir identity across headed/headless runs, callback context/page access, auth predicate truth/expiry, missing/busy profile, timeout/cancel, and `finally` close. Add a typed compile-time consumer test or build smoke for the exported API.
4. Document a local smoke procedure using a disposable account/profile outside the repository; do not run a live login unattended. Run `bun run spur-check`, `bun run build`, and package import smoke. `spur task check <wbs> --json` must pass before handoff to implementation.

### Solution

Built `@gobing-ai/ts-browser-automation` with three typed operations: caller-owned `openPersistentBrowser` (`packages/browser-automation/src/operations.ts:32`), headed `loginWithProfile` (`packages/browser-automation/src/operations.ts:59`), and scoped `withProfilePage` (`packages/browser-automation/src/operations.ts:102`). The shared readiness poll now enforces its deadline even when the caller predicate stalls (`packages/browser-automation/src/operations.ts:140`), and the launcher rejects an existing non-directory profile before opening Playwright (`packages/browser-automation/src/launcher.ts:57`). New regressions are at `packages/browser-automation/tests/operations.test.ts:137` and `packages/browser-automation/tests/launcher.test.ts:63`.

The package exposes typed errors (`packages/browser-automation/src/errors.ts:9`), an explicit profile resolver (`packages/browser-automation/src/profile-dir.ts:10`), and a lazy Playwright launcher (`packages/browser-automation/src/launcher.ts:95`). Public exports are in `packages/browser-automation/src/index.ts:18`; package metadata and the required peer are in `packages/browser-automation/package.json:2` and `packages/browser-automation/package.json:54`; source path aliases are in `packages/browser-automation/tsconfig.json:5`, with build settings in `packages/browser-automation/tsconfig.build.json:6`. The workspace registration is in `bun.lock:27`. Tests cover the public types (`packages/browser-automation/tests/consumer-types.test.ts:20`), errors (`packages/browser-automation/tests/errors.test.ts:12`), paths (`packages/browser-automation/tests/profile-dir.test.ts:5`), launcher (`packages/browser-automation/tests/launcher.test.ts:34`), and operations (`packages/browser-automation/tests/operations.test.ts:70`).

ADR-032 records the package boundary and platform exception (`docs/00_ADR.md:587`), mirrored by the rule exclusion (`.spur/rules/typescript/runtime-boundaries.yaml:115`) and architecture overview (`docs/03_ARCHITECTURE.md:249`). The public shape is documented in `docs/design/browser-profile-sessions.md:16`, indexed in `docs/04_DESIGN.md:28`; `docs/design/package-exports.md:18` and `AGENTS.md:22` include the package. Usage, sensitivity, and the local manual smoke recipe are in `packages/browser-automation/README.md:33`, `packages/browser-automation/README.md:101`, and `packages/browser-automation/README.md:112`. Feature tracking is in `docs/features/M_reusable-browser-profile-automation.md:68` and `docs/features/INDEX.md:20`.

Project status docs now match the shipped feature: browser automation is in scope (`docs/01_PRD.md:32`), Phase 2 is complete (`docs/02_ROADMAP.md:23`), and feature M is listed as done (`docs/05_FEATURES.md:39`).

Fresh checks: `bun run spur-check` passed with 2,578 tests, 0 failures, 55 pre-check and 2 post-check rules; `bun run build` passed for all 11 packages. The built entry point imported and listed all 10 runtime exports without launching a browser. The manual account smoke remains operator-run as specified in the README. Verification artifacts were refreshed at `.spur/run/0088-verify-answer.txt:1` and `.spur/run/0088-verdict.json:1` after the fixes.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/browser-automation/package.json:2` names the public package; `packages/browser-automation/package.json:40` provides build and test scripts; `packages/browser-automation/tsconfig.json:5` resolves the source dependency closure; `docs/00_ADR.md:587` records ADR-032. Full workspace build passed. |
| R2 | MET | `packages/browser-automation/src/operations.ts:59` opens a headed context and closes it in finally; `packages/browser-automation/src/operations.ts:140` bounds readiness polling; `packages/browser-automation/tests/operations.test.ts:137` proves a stalled predicate times out and closes. |
| R3 | MET | `packages/browser-automation/src/operations.ts:32` exposes the caller-owned context; `packages/browser-automation/src/operations.ts:102` scopes page and context access with finally closure; `packages/browser-automation/tests/operations.test.ts:224` exercises CDP access. |
| R4 | MET | `packages/browser-automation/src/launcher.ts:57` validates existing profile directories, rejects missing headless profiles and creates new ones with 0o700; `packages/browser-automation/tests/launcher.test.ts:35` checks mode; `packages/browser-automation/tests/launcher.test.ts:63` rejects an existing file; `packages/browser-automation/src/launcher.ts:80` maps busy profiles. |
| R5 | MET | `packages/browser-automation/src/operations.ts:9` lazily constructs the default launcher; `packages/browser-automation/src/launcher.ts:74` lazily imports Playwright; `packages/browser-automation/README.md:109` states app-specific choices remain with callers. Built entry point imported without browser launch. |
| R6 | MET | `packages/browser-automation/README.md:16` covers install and runtime requirements; `packages/browser-automation/README.md:33` and `packages/browser-automation/README.md:55` show headed login and headless reuse; `packages/browser-automation/README.md:112` provides a manual smoke recipe. The fake-launcher tests passed without live credentials. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC-1 | MET | test | `packages/browser-automation/tests/operations.test.ts:97` checks headed login, URL and close; `packages/browser-automation/tests/launcher.test.ts:35` checks owner-only directory creation. |
| AC-2 | MET | test | `packages/browser-automation/tests/operations.test.ts:107` checks profile identity across headed and headless calls; `packages/browser-automation/tests/operations.test.ts:190` checks callback handle and closure. |
| AC-3 | MET | test | `packages/browser-automation/tests/launcher.test.ts:45` checks missing; `packages/browser-automation/tests/launcher.test.ts:113` checks busy; `packages/browser-automation/tests/operations.test.ts:137` checks stalled timeout; `packages/browser-automation/tests/operations.test.ts:247` checks expired authentication. |
| AC-4 | MET | test | `bun run spur-check`: 2578 pass, 0 fail, both rule presets pass; `bun run build`: 11 packages succeed; `packages/browser-automation/tests/consumer-types.test.ts:20` checks public types; built entry point import listed all 10 exports. |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

<!-- spur:record-review -->

**SECU findings** (pipeline verify step — verdict: PASS)

| Priority | Dimension | Location | Finding |
|----------|-----------|----------|----------|
| P4 | spur task check | — | task check passed |
| P4 | design-conformance | — | Three public operations, one launcher, required Playwright peer, lazy import, predicate-only auth, and scoped closure match task Design and `docs/design/browser-profile-sessions.md:25`. |
| P4 | scope-creep | — | The changed package, docs, rule exclusion and tests map to R1-R6 and the task Plan. |
| P4 | evidence-rule-pass | — | Each behavior-bearing AC cites executable test or command evidence. |
| P4 | evidence-rule-pass | — | All behavior-bearing AC rows have executable evidence or are explicitly non-behavioral. |
| P4 | residual-sweep | — | blocking=0 deferrable=0 advisory=6 housekeeping=0 |

### References

- Source: `../knowledge-kit/packages/publish-harness/src/index.ts:236-329`; `../knowledge-kit/plugins/publishings/xhs-pub/src/index.ts:303-326`; `../knowledge-kit/docs/design/xhs-image-cards.md`.
- Repository: `AGENTS.md`; `docs/00_ADR.md` ADR-001/002/003/004/011/012; `docs/PACKAGE_RELEASE.md`; `packages/ai-runner/package.json`.
- Playwright: https://playwright.dev/docs/api/class-browsertype (`launchPersistentContext`, user-data directory and single-instance rule); https://playwright.dev/docs/auth (session-state sensitivity and expiry).

### History

- 2026-09-27T04:12:20.149Z backlog → todo (system)
- 2026-09-27T05:05:46.358Z todo → wip (system)
- 2026-09-27T05:47:03.936Z wip → testing (system)
- 2026-09-27T05:47:54.642Z testing → done (system)

