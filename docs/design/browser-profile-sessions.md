# Browser profile sessions (`ts-browser-automation`)

Public surface of `@gobing-ai/ts-browser-automation` (ADR-032). Single entry point `.`; the shapes
below are transcribed from `packages/browser-automation/src/index.ts`.

## Runtime requirement

`playwright` is a **required peer** at `^1.55.0`; the consumer installs the browser
(`npx playwright install chromium`). The peer is imported runtime-lazily, so module import has no
browser side effect (`sideEffects: false`). Public types are genuine Playwright types
(`BrowserContext`, `Page`) via type-only imports.

## Operations

```ts
openPersistentBrowser(options: OpenPersistentBrowserOptions): Promise<BrowserContext>
loginWithProfile(options: LoginWithProfileOptions): Promise<void>
withProfilePage<T>(options: WithProfilePageOptions, callback: (handle: ProfilePageHandle) => Promise<T>): Promise<T>
```

| Operation | Headless | Lifetime | Returns |
|-----------|----------|----------|---------|
| `openPersistentBrowser` | caller-supplied (required) | caller-owned — close in `finally` | the `BrowserContext` |
| `loginWithProfile` | always headed | closed on success, timeout, cancel, error | `void` once the predicate passes |
| `withProfilePage` | `headless` (default `false`) | scoped — `context.close()` in `finally` on every exit | the callback's value |

## Option shapes

```ts
type IsAuthenticatedPredicate = (page: Page) => boolean | Promise<boolean>;

interface OpenPersistentBrowserOptions {
    profileDir: string;
    headless: boolean;
    launcher?: BrowserLauncher;
}

interface LoginWithProfileOptions {
    profileDir: string;
    url: string;
    isAuthenticated: IsAuthenticatedPredicate;
    timeoutMs: number;
    signal?: AbortSignal;
    launcher?: BrowserLauncher;
}

interface WithProfilePageOptions {
    profileDir: string;
    headless?: boolean;          // default false
    url?: string;
    isAuthenticated?: IsAuthenticatedPredicate;
    timeoutMs?: number;          // default 30_000; ignored without isAuthenticated
    signal?: AbortSignal;
    launcher?: BrowserLauncher;
}

interface ProfilePageHandle {
    context: BrowserContext;     // caller-owned CDP via context.newCDPSession(page)
    page: Page;
}
```

Launcher seam (injectable for tests and custom provisioning):

```ts
interface ProfileLaunchRequest { profileDir: string; headless: boolean }
interface BrowserLauncher { launch(request: ProfileLaunchRequest): Promise<BrowserContext> }
interface PersistentLauncherOptions {
    loadPlaywright?: () => Promise<typeof import('playwright')>;
    fileSystem?: FileSystem;     // @gobing-ai/ts-runtime
}
```

## Behavioral shapes

- `profileDir` is resolved to an absolute path (relative inputs resolve against the cwd); empty or
  blank paths and existing non-directory paths reject with `InvalidProfileDirError`.
- An absent profile directory is created with mode `0o700` on a **headed** launch only. An existing
  directory is adopted in place — never moved, re-permissioned, or deleted.
- A **headless** launch against a missing profile throws `BrowserProfileMissingError` instead of
  creating an unauthenticated one.
- Authentication is established only by the caller's `isAuthenticated(page)` predicate, polled every
  250 ms until it passes or `timeoutMs` elapses. Filesystem state never implies a session.
- A non-finite or negative `timeoutMs` throws `TypeError` at operation entry, before any browser opens.
- The page handed to the predicate/callback is `context.pages()[0]` when present, else a new page.
  `url`, when supplied, is navigated before the predicate runs.
- No username, password, cookie, or profile content is read, logged, or exported.

## Error taxonomy

All extend `BrowserAutomationError`, so callers branch on class, not message text.

| Error | Raised when |
|-------|-------------|
| `InvalidProfileDirError` | `profileDir` is blank, is an existing non-directory, or does not resolve to an absolute path |
| `BrowserProfileMissingError` | headless launch and the profile directory does not exist |
| `BrowserProfileBusyError` | Chromium reports the profile locked by another instance (single-process profile rule) |
| `PlaywrightUnavailableError` | the `playwright` peer is absent, or Chromium is not installed |
| `LoginTimeoutError` | the predicate did not pass within the deadline; message carries the re-login instruction |
| `OperationAbortedError` | the caller's `AbortSignal` was aborted |

## Not in this surface

`connectOverCDP` and a `storageState` export are deferred (ADR-032); no channel registry, site
selectors, credential store, or app-specific profile-path default.
