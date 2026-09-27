import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { joinPath, nodeBunFactory } from '@gobing-ai/ts-runtime';
import type { BrowserContext } from 'playwright';
import {
    BrowserProfileBusyError,
    BrowserProfileMissingError,
    InvalidProfileDirError,
    PlaywrightUnavailableError,
} from '../src/errors';
import { createPersistentLauncher, defaultLoadPlaywright, ensureProfileDir } from '../src/launcher';

/** Build a fake `typeof import('playwright')` whose chromium launch is a spy. */
function fakePlaywright(
    implementation: (profileDir: string, options: { headless: boolean }) => Promise<BrowserContext>,
) {
    const calls: Array<{ profileDir: string; options: { headless: boolean } }> = [];
    const module = {
        chromium: {
            launchPersistentContext: async (profileDir: string, options: { headless: boolean }) => {
                calls.push({ profileDir, options });
                return implementation(profileDir, options);
            },
        },
    } as unknown as typeof import('playwright');
    return { module, calls };
}

function tempRoot(): string {
    return mkdtempSync(joinPath(tmpdir(), 'browser-automation-test-'));
}

describe('profile directory lifecycle via launcher (task 0088 R4)', () => {
    it('creates a missing profile directory owner-only (0o700) on a headed launch', async () => {
        const profileDir = joinPath(tempRoot(), 'fresh-profile');
        const fs = nodeBunFactory.createFileSystem();

        await ensureProfileDir(profileDir, false, fs);

        expect(existsSync(profileDir)).toBe(true);
        expect(statSync(profileDir).mode & 0o777).toBe(0o700);
    });

    it('fails a headless run against a missing profile instead of silently creating one', async () => {
        const profileDir = joinPath(tempRoot(), 'never-created');
        const fs = nodeBunFactory.createFileSystem();

        expect(ensureProfileDir(profileDir, true, fs)).rejects.toThrow(BrowserProfileMissingError);
        expect(existsSync(profileDir)).toBe(false);
    });

    it('adopts an existing profile directory in place without re-permissioning', async () => {
        const profileDir = joinPath(tempRoot(), 'existing-profile');
        mkdirSync(profileDir, { mode: 0o750 });
        const fs = nodeBunFactory.createFileSystem();

        await ensureProfileDir(profileDir, false, fs);

        expect(statSync(profileDir).mode & 0o777).toBe(0o750);
    });

    it('rejects an existing file as an invalid profile directory', async () => {
        const profileDir = joinPath(tempRoot(), 'not-a-directory');
        writeFileSync(profileDir, '');

        await expect(ensureProfileDir(profileDir, false, nodeBunFactory.createFileSystem())).rejects.toThrow(
            InvalidProfileDirError,
        );
    });
});

describe('persistent launcher (task 0088 R1/R3/R4)', () => {
    it('passes headed options through to Playwright and resolves the profile path', async () => {
        const { module, calls } = fakePlaywright(async () => ({}) as BrowserContext);
        const launcher = createPersistentLauncher({ loadPlaywright: async () => module });

        await launcher.launch({ profileDir: joinPath(tempRoot(), 'headed'), headless: false });

        expect(calls).toHaveLength(1);
        expect(calls[0]?.options).toEqual({ headless: false });
        expect(calls[0]?.profileDir.startsWith('/')).toBe(true);
    });

    it('uses one launcher identity for headed and headless launches', async () => {
        const { module, calls } = fakePlaywright(async () => ({}) as BrowserContext);
        const launcher = createPersistentLauncher({ loadPlaywright: async () => module });
        const profileDir = joinPath(tempRoot(), 'shared-profile');

        await launcher.launch({ profileDir, headless: false });
        await launcher.launch({ profileDir, headless: true });

        expect(calls[0]?.profileDir).toBe(calls[1]?.profileDir);
        expect(calls[1]?.options).toEqual({ headless: true });
    });

    it('fails before loading Playwright when a headless profile is missing', async () => {
        let playwrightLoaded = false;
        const { module } = fakePlaywright(async () => ({}) as BrowserContext);
        const launcher = createPersistentLauncher({
            loadPlaywright: async () => {
                playwrightLoaded = true;
                return module;
            },
        });

        const missing = joinPath(tempRoot(), 'absent-profile');
        expect(launcher.launch({ profileDir: missing, headless: true })).rejects.toThrow(BrowserProfileMissingError);
        expect(playwrightLoaded).toBe(false);
    });

    it('maps the Chromium singleton failure to BrowserProfileBusyError', async () => {
        const { module } = fakePlaywright(async () => {
            throw new Error('ProcessSingleton: the profile is already in use by another chrome instance');
        });
        const launcher = createPersistentLauncher({ loadPlaywright: async () => module });
        const profileDir = joinPath(tempRoot(), 'busy-profile');

        expect(launcher.launch({ profileDir, headless: false })).rejects.toThrow(BrowserProfileBusyError);
    });

    it('maps a missing Chromium executable to PlaywrightUnavailableError', async () => {
        const { module } = fakePlaywright(async () => {
            throw new Error(`Executable doesn't exist at /fake/chromium. Please run npx playwright install`);
        });
        const launcher = createPersistentLauncher({ loadPlaywright: async () => module });

        expect(launcher.launch({ profileDir: tempRoot(), headless: false })).rejects.toThrow(
            PlaywrightUnavailableError,
        );
    });

    it('rethrows unrelated launch failures untouched', async () => {
        const failure = new Error('some other crash');
        const { module } = fakePlaywright(async () => {
            throw failure;
        });
        const launcher = createPersistentLauncher({ loadPlaywright: async () => module });

        expect(launcher.launch({ profileDir: tempRoot(), headless: false })).rejects.toBe(failure);
    });

    it('surfaces a missing playwright peer as PlaywrightUnavailableError', async () => {
        const launcher = createPersistentLauncher({
            loadPlaywright: async () => {
                throw new Error("Cannot find module 'playwright'");
            },
        });

        expect(launcher.launch({ profileDir: tempRoot(), headless: false })).rejects.toThrow(
            PlaywrightUnavailableError,
        );
    });

    it('resolves the installed playwright peer lazily without launching a browser', async () => {
        const playwright = await defaultLoadPlaywright();

        expect(typeof playwright.chromium.launchPersistentContext).toBe('function');
    });
});
