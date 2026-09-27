---
schema_version: 1
name: Build reusable Playwright browser profile sessions in ts-browser-automation
status: todo
template: standard
created_at: 2026-09-27T04:10:31.948Z
updated_at: "2026-09-27T04:13:12.663Z"

feature_id: M
ac_numbering: task-local
estimate_hours: 12
---

## 0088. Build reusable Playwright browser profile sessions in ts-browser-automation

### Background

The knowledge-kit E8 XHS script driver currently obtains a persistent Chromium context through `packages/publish-harness/src/index.ts:307` and reuses `~/.config/kk/browser-profiles/<channel>`. Its caller casts the returned context from `unknown`, picks a page, and closes the context (`plugins/publishings/xhs-pub/src/index.ts:303-326`). The general lifecycle belongs in a separately published ts-libs package so other projects can use dedicated profiles. Playwright documents that the user-data directory stores session state and cannot be opened by concurrent browser instances. It also warns against automating a user's regular Chrome profile. This task creates one reusable package; knowledge-kit migration is a separate downstream task.

Decision: name the package `@gobing-ai/ts-browser-automation` (`packages/browser-automation`) instead of `ts-web-tools`; its scope is browser sessions, not arbitrary web utilities. New package design must follow ts-libs ADR-001/002/003/004/011/012 and `docs/PACKAGE_RELEASE.md`. Add a dated ADR for the browser adapter's platform API ownership and Playwright dependency strategy before implementing a cross-package boundary.

### Requirements

- [ ] R1. Add a public, independently buildable `@gobing-ai/ts-browser-automation` workspace package with typed exports, README, package metadata, lockstep current version, and the repository's build/typecheck/test/release conventions. Use `@gobing-ai/ts-runtime` for generic filesystem/path/process operations where it covers the need; explicitly document any narrow browser adapter exception in an ADR. Do not change the release workflow.
- [ ] R2. Provide a headed Chromium login operation that accepts an explicit dedicated `profileDir`, a login URL, an application-owned async `isAuthenticated(page)` predicate, and a finite timeout. It opens a visible browser, allows the user to sign in on the site, reports success only after the predicate passes, and closes the context on success, timeout, cancellation, or error. Never collect plaintext passwords or infer authentication from profile existence.
- [ ] R3. Provide a typed low-level persistent-context opener plus a scoped callback helper for later automation: accept the same `profileDir`, open a Playwright `BrowserContext`/`Page`, run caller actions, and close the scoped helper in `finally`. Require a caller-owned readiness predicate before claiming an authenticated session; on expiry, fail with a recoverable re-login instruction. The callback has normal Playwright page/locator/file upload APIs and access to Chromium CDP via the context for caller-owned cases such as XHS's closed-shadow control.
- [ ] R4. Treat the profile as sensitive session material: create a dedicated directory with owner-only access on supported local filesystems, do not copy/export cookies into logs or repository files, reject empty/invalid profile paths, and fail clearly on a profile already in use. A headless run against a missing profile must fail instead of silently creating an unauthenticated one. Existing profile directories are adopted in place without moving or deleting their contents.
- [ ] R5. Keep app-specific choices outside the package: no `~/.config/kk` default, channel registry, site selectors, CAPTCHA bypass, publishing workflow, draft/public switch, or synthetic success result. The package has no browser side effect at module import time.
- [ ] R6. Document install/runtime requirements, headed login → headless reuse example, profile sensitivity, single-process profile rule, auth expiry, and the fact that some sites may reject headless automation. Exercise lifecycle and failure cases using a fake launcher plus one manual local smoke recipe; no live account or credentials in automated tests.

### Acceptance Criteria

- [ ] AC1 — A user can sign in once with a dedicated visible browser profile (req: R2, R4)
- [ ] AC2 — An authenticated profile can drive a later headless browser callback (req: R3)
- [ ] AC3 — Missing, busy, expired, and timed-out profiles fail without a false authenticated result (req: R2, R3, R4)
- [ ] AC4 — The browser package builds and loads independently of knowledge-kit (req: R1, R5, R6)

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

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- Source: `../knowledge-kit/packages/publish-harness/src/index.ts:236-329`; `../knowledge-kit/plugins/publishings/xhs-pub/src/index.ts:303-326`; `../knowledge-kit/docs/design/xhs-image-cards.md`.
- Repository: `AGENTS.md`; `docs/00_ADR.md` ADR-001/002/003/004/011/012; `docs/PACKAGE_RELEASE.md`; `packages/ai-runner/package.json`.
- Playwright: https://playwright.dev/docs/api/class-browsertype (`launchPersistentContext`, user-data directory and single-instance rule); https://playwright.dev/docs/auth (session-state sensitivity and expiry).

### History

- 2026-09-27T04:12:20.149Z backlog → todo (system)

