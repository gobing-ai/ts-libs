import { describe, expect, it } from 'bun:test';
import type { BrowserContext, Page } from 'playwright';
import {
    type BrowserLauncher,
    BrowserProfileMissingError,
    type LoginWithProfileOptions,
    loginWithProfile,
    type OpenPersistentBrowserOptions,
    openPersistentBrowser,
    type ProfilePageHandle,
    type WithProfilePageOptions,
    withProfilePage,
} from '../src/index';

/**
 * Compile-time consumer smoke (task 0088 AC4): the exported surface must be
 * usable from a plain consumer with genuine Playwright types, without
 * launching anything.
 */
describe('public API type surface (task 0088 AC4)', () => {
    it('accepts fully-typed option objects, launcher, and callbacks', async () => {
        const launcher: BrowserLauncher = {
            launch: async (request: { profileDir: string; headless: boolean }) => {
                expect(typeof request.profileDir).toBe('string');
                throw new BrowserProfileMissingError(request.profileDir);
            },
        };

        const openOptions: OpenPersistentBrowserOptions = {
            profileDir: '/tmp/consumer-profile',
            headless: false,
            launcher,
        };
        const loginOptions: LoginWithProfileOptions = {
            profileDir: '/tmp/consumer-profile',
            url: 'https://example.test/login',
            isAuthenticated: async (page) => page !== undefined,
            timeoutMs: 1_000,
            signal: new AbortController().signal,
        };
        const scopedOptions: WithProfilePageOptions = {
            profileDir: '/tmp/consumer-profile',
            headless: true,
            url: 'https://example.test/',
            isAuthenticated: () => false,
            timeoutMs: 500,
        };

        expect(typeof openPersistentBrowser).toBe('function');
        expect(typeof loginWithProfile).toBe('function');
        expect(typeof withProfilePage).toBe('function');
        expect(openOptions.headless).toBe(false);
        expect(loginOptions.timeoutMs).toBe(1_000);
        expect(scopedOptions.url).toBe('https://example.test/');

        // Handle is typed with genuine Playwright shapes (compile-time assignment).
        const handle: ProfilePageHandle = { context: {} as BrowserContext, page: {} as Page };
        expect(handle.context).toBeInstanceOf(Object);

        // The launcher type is satisfied by a plain object literal — injectability contract.
        const replacements: BrowserLauncher[] = [launcher];
        expect(replacements).toHaveLength(1);
    });
});
