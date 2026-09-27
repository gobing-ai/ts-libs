/**
 * Browser adapter — the single sanctioned exception to the ts-runtime
 * platform-API ownership rule (ADR-032): the Playwright runtime import and
 * the owner-only (0o700) creation of the profile directory live in this
 * module and nowhere else. Generic path math and existence checks route
 * through @gobing-ai/ts-runtime. No browser side effect happens at import.
 */
import { mkdir } from 'node:fs/promises';
import { type FileSystem, nodeBunFactory } from '@gobing-ai/ts-runtime';
import type { BrowserContext } from 'playwright';
import {
    BrowserProfileBusyError,
    BrowserProfileMissingError,
    InvalidProfileDirError,
    PlaywrightUnavailableError,
} from './errors';
import { resolveProfileDir } from './profile-dir';

/** Owner-only access for a newly created profile directory (existing directories are adopted in place). */
const PROFILE_DIR_MODE = 0o700;

/** Chromium singleton/lock failure signatures surfaced by Playwright when a profile is already open. */
const BUSY_PROFILE_PATTERN = /singleton|already in use|in use by another/i;

/** Playwright's "browser executable missing" signature. */
const CHROMIUM_MISSING_PATTERN = /playwright install|executable doesn't exist/i;

/** Request for one persistent-context launch. `profileDir` is resolved to an absolute path before launch. */
export interface ProfileLaunchRequest {
    profileDir: string;
    headless: boolean;
}

/**
 * Seam for opening a persistent Chromium context. The package's default
 * implementation is {@link createPersistentLauncher}; tests and consumers may
 * inject their own to fake or customise browser provisioning.
 */
export interface BrowserLauncher {
    launch(request: ProfileLaunchRequest): Promise<BrowserContext>;
}

/** Options for the internal persistent launcher; all fields optional with safe defaults. */
export interface PersistentLauncherOptions {
    /** Playwright loader override (tests inject a fake; the default lazily imports the peer). */
    loadPlaywright?: () => Promise<typeof import('playwright')>;
    /** Filesystem for profile-directory existence checks (default: ts-runtime node/bun). */
    fileSystem?: FileSystem;
}

/**
 * Create the profile directory with owner-only permissions when it does not
 * exist. A headless run never creates one: an absent profile means no
 * authenticated session exists, and silently launching a fresh one would
 * fake a login (task 0088 R4).
 */
export async function ensureProfileDir(profileDir: string, headless: boolean, fs: FileSystem): Promise<void> {
    const existing = await fs.stat(profileDir);
    if (existing) {
        if (!existing.isDirectory())
            throw new InvalidProfileDirError(`profileDir is not a directory: "${profileDir}".`);
        return; // adopt the existing directory in place — never move, re-permission, or delete
    }
    if (headless) throw new BrowserProfileMissingError(profileDir);
    await mkdir(profileDir, { recursive: true, mode: PROFILE_DIR_MODE });
}

/**
 * @internal Test-visible seam: the real runtime-lazy `import('playwright')`.
 * Exported only so the coverage test can execute it without launching a
 * browser — every default-launcher path that reaches it would call the real
 * `launchPersistentContext` next.
 */
export async function defaultLoadPlaywright(): Promise<typeof import('playwright')> {
    return import('playwright');
}

function mapLaunchError(profileDir: string, error: unknown): unknown {
    const message = error instanceof Error ? error.message : String(error);
    if (BUSY_PROFILE_PATTERN.test(message)) return new BrowserProfileBusyError(profileDir, error);
    if (CHROMIUM_MISSING_PATTERN.test(message)) {
        return new PlaywrightUnavailableError(
            'Chromium is not installed for Playwright. Run `npx playwright install chromium` and retry.',
            { cause: error },
        );
    }
    return error;
}

/**
 * Default {@link BrowserLauncher}: lazily imports the `playwright` peer,
 * guarantees an owner-only profile directory, and maps known Chromium/Playwright
 * launch failures onto this package's typed errors.
 */
export function createPersistentLauncher(options: PersistentLauncherOptions = {}): BrowserLauncher {
    const loadPlaywright = options.loadPlaywright ?? defaultLoadPlaywright;
    const fs = options.fileSystem ?? nodeBunFactory.createFileSystem();
    return {
        async launch(request: ProfileLaunchRequest): Promise<BrowserContext> {
            const profileDir = resolveProfileDir(request.profileDir);
            await ensureProfileDir(profileDir, request.headless, fs);
            let playwright: typeof import('playwright');
            try {
                playwright = await loadPlaywright();
            } catch (error) {
                if (error instanceof PlaywrightUnavailableError) throw error;
                throw new PlaywrightUnavailableError(
                    'The "playwright" peer dependency is not installed. Add playwright@^1.55.0 to your dependencies ' +
                        'and run `npx playwright install chromium` to download the browser.',
                    { cause: error },
                );
            }
            try {
                return await playwright.chromium.launchPersistentContext(profileDir, { headless: request.headless });
            } catch (error) {
                throw mapLaunchError(profileDir, error);
            }
        },
    };
}
