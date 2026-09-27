# @gobing-ai/ts-browser-automation

Reusable Playwright persistent browser profile sessions: sign in once with a
dedicated visible Chromium profile, then drive later automation headless against
the same profile. Extracted from knowledge-kit's XHS publish flow (task 0088,
[ADR-032](../../docs/00_ADR.md)).

Part of the `@gobing-ai/ts-libs` monorepo and lockstep-versioned with it.

- **License:** Apache-2.0.
- The package never stores usernames/passwords and never exports cookies — the
  Playwright user-data directory itself is the login artifact.

---

## Install & runtime requirements

```sh
bun add @gobing-ai/ts-browser-automation
# Playwright is a required peer dependency (^1.55.0):
bun add playwright@^1.55.0
# Chromium is owned by the consumer (ADR-032):
npx playwright install chromium
```

- **Runtime:** Node.js or Bun with Playwright's supported platforms.
- A missing `playwright` peer or missing Chromium fails with a typed
  `PlaywrightUnavailableError` at launch time — never at import. Importing the
  module has no browser side effect.

## Usage

### 1. One-time headed login into a dedicated profile

```ts
import { loginWithProfile } from '@gobing-ai/ts-browser-automation';

// You choose where the profile lives — the package has no default location.
const profileDir = `${process.env.HOME}/.local/share/myapp/browser-profiles/xhs`;

await loginWithProfile({
    profileDir,
    url: 'https://example-site.test/login',
    // Site-owned readiness check: only your predicate can declare success.
    isAuthenticated: async (page) => page.url().includes('/dashboard'),
    timeoutMs: 5 * 60_000,
});
```

A visible browser opens; sign in by hand. The context closes once your
predicate passes — or on timeout, cancellation (`signal`), or error. If the
deadline expires you get `LoginTimeoutError` with a re-login instruction; just
run `loginWithProfile` again with the same `profileDir`.

### 2. Later automation reusing the authenticated profile

```ts
import { withProfilePage } from '@gobing-ai/ts-browser-automation';

const result = await withProfilePage(
    {
        profileDir,
        headless: true,
        url: 'https://example-site.test/feed',
        // Guard the claim of an authenticated session (task 0088 R3):
        isAuthenticated: (page) => page.url().includes('/feed'),
        timeoutMs: 30_000,
    },
    async ({ context, page }) => {
        // Full Playwright page/locator/upload APIs. Site-specific CDP is
        // caller-owned, e.g. for closed-shadow DOM control:
        const cdp = await context.newCDPSession(page);
        return page.locator('#app').innerText();
    },
);
```

`withProfilePage` guarantees `context.close()` in a `finally` on every exit
path. For full manual control (e.g. keeping one context across many steps),
use the low-level `openPersistentBrowser({ profileDir, headless })` and close
the returned `BrowserContext` yourself.

## Behavior guarantees

- **Dedicated profile, explicit path.** `profileDir` is required (empty/blank
  or an existing file → `InvalidProfileDirError`) and resolved to an absolute
  path. Relative input resolves against the current working directory.
- **Owner-only creation.** A missing profile directory is created with `0o700`
  on a headed launch, on local filesystems that enforce permission bits (POSIX;
  mode bits are a no-op on Windows). Existing directories are adopted in place —
  never moved, re-permissioned, or deleted.
- **No silent unauthenticated sessions.** A headless run against a missing
  profile fails with `BrowserProfileMissingError` instead of creating a fresh,
  unauthenticated one.
- **Single-process rule.** Playwright user-data directories hold session state
  and cannot be opened by concurrent browser instances. One profile = one
  browser at a time; concurrent use surfaces as `BrowserProfileBusyError`.
- **Auth expiry is recoverable.** A profile whose site session has expired
  fails the readiness predicate with `LoginTimeoutError` (message includes the
  re-login instruction) — it never reports a false authenticated result.
- **Sensitive material.** Cookies and local storage in the profile are session
  material: never log profile contents, never commit a profile directory.

## Caveats

- **Some sites reject headless automation.** The headed path always remains
  available for debugging (`headless: false` or `loginWithProfile`); the
  package does not promise headless success on every site.
- **App-specific choices stay outside the package** — no default profile
  location, site selectors, or credentials. Callers own all of them.

## Manual smoke (local, never unattended)

1. Pick a disposable account and a profile directory outside this repository:
   `PROFILE="$HOME/tmp/smoke-profile-$$"`.
2. Headed login: `loginWithProfile({ profileDir: PROFILE, url: 'https://example-site.test/login', isAuthenticated: (p) => p.url().includes('/home'), timeoutMs: 300_000 })`
   — sign in manually, confirm the context closes after your predicate passes.
3. Headless reuse: run the `withProfilePage` example above with
   `headless: true` and confirm the callback sees the authenticated page.
4. Failure cases: re-run headless with a fresh non-existent `PROFILE`
   (expect `BrowserProfileMissingError`); open the same profile in a second
   browser and re-run (expect `BrowserProfileBusyError`); delete cookies via
   the site and re-run with the predicate (expect `LoginTimeoutError`).

Use a throwaway account. Do not run the headed-login step unattended or in CI.
