import type { BrowserContext, Page } from 'playwright';
import { LoginTimeoutError, OperationAbortedError } from './errors';
import { type BrowserLauncher, createPersistentLauncher } from './launcher';
import { resolveProfileDir } from './profile-dir';

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

// Lazily built so importing the module has no side effects (sideEffects: false).
let defaultLauncher: BrowserLauncher | undefined;
function getDefaultLauncher(): BrowserLauncher {
    if (defaultLauncher === undefined) defaultLauncher = createPersistentLauncher();
    return defaultLauncher;
}

/** Caller-owned readiness check. The package never infers authentication from profile state. */
export type IsAuthenticatedPredicate = (page: Page) => boolean | Promise<boolean>;

/** Options for the low-level persistent-context opener with caller-owned lifetime. */
export interface OpenPersistentBrowserOptions {
    /** Dedicated Chromium user-data directory (created owner-only when absent; adopted in place when present). */
    profileDir: string;
    headless: boolean;
    /** Launcher override (tests / custom browser provisioning). */
    launcher?: BrowserLauncher;
}

/**
 * Low-level persistent-context opener. The returned context's lifetime is
 * caller-owned — close it in a `finally` block, or prefer {@link withProfilePage}.
 */
export async function openPersistentBrowser(options: OpenPersistentBrowserOptions): Promise<BrowserContext> {
    return (options.launcher ?? getDefaultLauncher()).launch({
        profileDir: resolveProfileDir(options.profileDir),
        headless: options.headless,
    });
}

/** Options for the headed one-time login that polls the caller's readiness predicate. */
export interface LoginWithProfileOptions {
    /** Dedicated Chromium user-data directory. */
    profileDir: string;
    /** Login page to open in the visible browser. */
    url: string;
    /** Site-owned readiness check polled until it passes or the deadline expires. */
    isAuthenticated: IsAuthenticatedPredicate;
    /** Finite deadline for predicate confirmation. */
    timeoutMs: number;
    signal?: AbortSignal;
    launcher?: BrowserLauncher;
}

/**
 * Open a headed browser on `url`, let the user sign in, and resolve only once
 * `isAuthenticated(page)` passes. The context is closed on success, timeout,
 * cancellation, and error. No credential is ever read or stored — the profile
 * directory itself is the login artifact.
 */
export async function loginWithProfile(options: LoginWithProfileOptions): Promise<void> {
    assertNotAborted(options.signal);
    assertFiniteTimeoutMs(options.timeoutMs);
    const context = await (options.launcher ?? getDefaultLauncher()).launch({
        profileDir: resolveProfileDir(options.profileDir),
        headless: false,
    });
    try {
        const page = await openPage(context);
        await page.goto(options.url);
        await pollPredicate(page, options.isAuthenticated, options.timeoutMs, options.signal);
    } finally {
        await context.close();
    }
}

/** Handle returned to the callback with the opened context and its page. */
export interface ProfilePageHandle {
    context: BrowserContext;
    page: Page;
}

/** Options for the scoped callback helper that guarantees context closure in `finally`. */
export interface WithProfilePageOptions {
    /** Dedicated Chromium user-data directory. */
    profileDir: string;
    /** Headless reuse defaults to `false`; pass `true` for unattended runs (requires an existing profile). */
    headless?: boolean;
    url?: string;
    /** When provided, the callback runs only after the readiness predicate passes (task 0088 R3). */
    isAuthenticated?: IsAuthenticatedPredicate;
    /** Deadline for predicate confirmation (default 30s; ignored without `isAuthenticated`). */
    timeoutMs?: number;
    signal?: AbortSignal;
    launcher?: BrowserLauncher;
}

/**
 * Scoped session helper: launch a persistent context, hand the caller
 * `{ context, page }`, and guarantee `context.close()` in `finally` on every
 * exit path. `context` is a genuine Playwright context — callers own
 * site-specific CDP via `context.newCDPSession(page)`.
 */
export async function withProfilePage<T>(
    options: WithProfilePageOptions,
    callback: (handle: ProfilePageHandle) => Promise<T>,
): Promise<T> {
    assertNotAborted(options.signal);
    if (options.isAuthenticated !== undefined) assertFiniteTimeoutMs(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const context = await (options.launcher ?? getDefaultLauncher()).launch({
        profileDir: resolveProfileDir(options.profileDir),
        headless: options.headless ?? false,
    });
    try {
        const page = await openPage(context);
        if (options.url !== undefined) await page.goto(options.url);
        if (options.isAuthenticated !== undefined) {
            await pollPredicate(page, options.isAuthenticated, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal);
        }
        return await callback({ context, page });
    } finally {
        await context.close();
    }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new OperationAbortedError();
}

async function openPage(context: BrowserContext): Promise<Page> {
    const existing = context.pages()[0];
    return existing ?? (await context.newPage());
}

/** Rejects a non-finite or negative timeout at op entry — before any browser opens — so a bad value cannot park a headed window in an endless poll. */
function assertFiniteTimeoutMs(timeoutMs: number): void {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw new TypeError(`timeoutMs must be a finite non-negative number of milliseconds; received ${timeoutMs}`);
    }
}

async function pollPredicate(
    page: Page,
    predicate: IsAuthenticatedPredicate,
    timeoutMs: number,
    signal: AbortSignal | undefined,
): Promise<void> {
    const timeoutError = new LoginTimeoutError(
        `Authentication was not confirmed within ${timeoutMs}ms. The profile's site session has likely ` +
            'expired or the sign-in was not completed: re-run loginWithProfile() with the same profileDir to sign in again.',
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let stopped = false;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError), timeoutMs);
        if (signal) {
            onAbort = () => reject(new OperationAbortedError());
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
        }
    });
    const poll = async () => {
        for (;;) {
            if (stopped) return;
            assertNotAborted(signal);
            if (await predicate(page)) return;
            await sleep(POLL_INTERVAL_MS);
        }
    };
    try {
        await Promise.race([poll(), deadline]);
    } finally {
        stopped = true;
        if (timer) clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
