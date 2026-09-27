import { describe, expect, it } from 'bun:test';
import type { BrowserContext, Page } from 'playwright';
import { InvalidProfileDirError, LoginTimeoutError, OperationAbortedError } from '../src/errors';
import type { BrowserLauncher, ProfileLaunchRequest } from '../src/launcher';
import { loginWithProfile, openPersistentBrowser, withProfilePage } from '../src/operations';

interface FakePageState {
    gotoCalls: string[];
}

/** Minimal fake Page: only what the operations touch (goto, predicate argument). */
function fakePage(): { page: Page; state: FakePageState } {
    const state: FakePageState = { gotoCalls: [] };
    const page = {
        goto: async (url: string) => {
            state.gotoCalls.push(url);
            return null;
        },
    } as unknown as Page;
    return { page, state };
}

/** Minimal fake BrowserContext with close/pages/newPage spies. */
function fakeContext(initialPages: Page[] = []) {
    let closeCalls = 0;
    let newPageCalls = 0;
    const { page, state } = fakePage();
    const context = {
        pages: () => [...initialPages],
        newPage: async () => {
            newPageCalls++;
            return page;
        },
        close: async () => {
            closeCalls++;
        },
    } as unknown as BrowserContext;
    return { context, page, state, closeCalls: () => closeCalls, newPageCalls: () => newPageCalls };
}

/** Fake BrowserLauncher: records every launch request, hands out fresh fake contexts. No browser, no network. */
function fakeLauncher() {
    const requests: ProfileLaunchRequest[] = [];
    const contexts: Array<ReturnType<typeof fakeContext>> = [];
    const launcher: BrowserLauncher = {
        launch: async (request: ProfileLaunchRequest) => {
            requests.push(request);
            const fake = fakeContext();
            contexts.push(fake);
            return fake.context;
        },
    };
    return { launcher, requests, contexts };
}

const alwaysAuthenticated = () => true;

function loginOptions(
    overrides?: Partial<Parameters<typeof loginWithProfile>[0]>,
): Parameters<typeof loginWithProfile>[0] {
    return {
        profileDir: '/tmp/login-profile',
        url: 'https://example.test/login',
        isAuthenticated: alwaysAuthenticated,
        timeoutMs: 5_000,
        ...overrides,
    };
}

describe('openPersistentBrowser (task 0088 R3)', () => {
    it('opens a persistent context and leaves its lifetime to the caller', async () => {
        const { launcher, requests, contexts } = fakeLauncher();

        const context = await openPersistentBrowser({ profileDir: '/tmp/some-profile', headless: true, launcher });

        expect(contexts[0]?.context).toBe(context);
        expect(requests[0]).toEqual({ profileDir: '/tmp/some-profile', headless: true });
        expect(contexts[0]?.closeCalls()).toBe(0); // caller-owned lifetime — not closed here
    });

    it('rejects blank profileDir before touching the launcher', async () => {
        const { launcher, requests } = fakeLauncher();
        expect(openPersistentBrowser({ profileDir: '  ', headless: false, launcher })).rejects.toThrow(
            InvalidProfileDirError,
        );
        expect(requests).toHaveLength(0);
    });

    it('builds the default launcher lazily and still rejects a blank dir before any launch', async () => {
        // No `launcher` option: exercises the lazy default build; the blank-dir
        // rejection then fires before `.launch` is ever invoked.
        expect(openPersistentBrowser({ profileDir: '   ', headless: false })).rejects.toThrow(InvalidProfileDirError);
    });
});

describe('loginWithProfile (task 0088 R2/R4)', () => {
    it('runs headed on the login URL and closes the context on success', async () => {
        const { launcher, requests, contexts } = fakeLauncher();

        await loginWithProfile(loginOptions({ launcher }));

        expect(requests[0]?.headless).toBe(false);
        expect(contexts[0]?.state.gotoCalls).toEqual(['https://example.test/login']);
        expect(contexts[0]?.closeCalls()).toBe(1);
    });

    it('resolves the same profileDir for headed login and headless reuse (identity)', async () => {
        const { launcher, requests } = fakeLauncher();
        const profileDir = 'profiles/channel'; // relative on purpose — both runs must see the same resolved dir

        await loginWithProfile(loginOptions({ profileDir, launcher }));
        await withProfilePage({ profileDir, headless: true, launcher }, async () => undefined);

        expect(requests[0]?.profileDir).toBe(requests[1]?.profileDir);
        expect(requests[0]?.profileDir.startsWith('/')).toBe(true);
        expect(requests[0]?.headless).toBe(false);
        expect(requests[1]?.headless).toBe(true);
    });

    it('fails with a recoverable re-login instruction when the predicate never passes', async () => {
        const { launcher, contexts } = fakeLauncher();

        const error = await loginWithProfile(
            loginOptions({ isAuthenticated: () => false, timeoutMs: 0, launcher }),
        ).then(
            () => {
                throw new Error('expected rejection');
            },
            (caught: unknown) => caught,
        );

        expect(error).toBeInstanceOf(LoginTimeoutError);
        expect((error as Error).message).toMatch(/loginWithProfile/);
        expect(contexts[0]?.closeCalls()).toBe(1); // closed on timeout
    });

    it('times out and closes even when the readiness predicate never settles', async () => {
        const { launcher, contexts } = fakeLauncher();

        await expect(
            loginWithProfile(
                loginOptions({ isAuthenticated: () => new Promise<boolean>(() => {}), timeoutMs: 20, launcher }),
            ),
        ).rejects.toThrow(LoginTimeoutError);

        expect(contexts[0]?.closeCalls()).toBe(1);
    });

    it('rejects a non-finite timeoutMs before launching the browser', async () => {
        const { launcher, requests } = fakeLauncher();

        await expect(loginWithProfile(loginOptions({ timeoutMs: Number.NaN, launcher }))).rejects.toThrow(TypeError);
        await expect(loginWithProfile(loginOptions({ timeoutMs: -1, launcher }))).rejects.toThrow(
            /finite non-negative/,
        );
        expect(requests).toHaveLength(0);
    });

    it('fails fast with OperationAbortedError when the signal is already aborted', async () => {
        const { launcher, requests } = fakeLauncher();
        const controller = new AbortController();
        controller.abort();

        expect(loginWithProfile(loginOptions({ signal: controller.signal, launcher }))).rejects.toThrow(
            OperationAbortedError,
        );
        expect(requests).toHaveLength(0); // cancelled before any browser launch
    });

    it('cancels mid-poll and still closes the context', async () => {
        const { launcher, contexts } = fakeLauncher();
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);

        await expect(
            loginWithProfile(
                loginOptions({
                    isAuthenticated: () => false,
                    timeoutMs: 10_000,
                    signal: controller.signal,
                    launcher,
                }),
            ),
        ).rejects.toThrow(OperationAbortedError);

        expect(contexts[0]?.closeCalls()).toBe(1);
    });
});

describe('withProfilePage (task 0088 R3/AC2)', () => {
    it('hands the callback the context and page and closes in finally on success', async () => {
        const { launcher, contexts } = fakeLauncher();
        let seenContext: BrowserContext | undefined;
        let seenPage: Page | undefined;

        const result = await withProfilePage(
            { profileDir: '/tmp/reuse-profile', headless: true, launcher },
            async (handle) => {
                seenContext = handle.context;
                seenPage = handle.page;
                return 42;
            },
        );

        expect(result).toBe(42);
        expect(seenContext).toBe(contexts[0]?.context);
        expect(seenPage).toBe(contexts[0]?.page);
        expect(contexts[0]?.newPageCalls()).toBe(1);
        expect(contexts[0]?.closeCalls()).toBe(1);
    });

    it('closes the context even when the callback throws', async () => {
        const { launcher, contexts } = fakeLauncher();
        const failure = new Error('callback exploded');

        expect(
            withProfilePage({ profileDir: '/tmp/reuse-profile', headless: true, launcher }, async () => {
                throw failure;
            }),
        ).rejects.toBe(failure);
        expect(contexts[0]?.closeCalls()).toBe(1);
    });

    it('exposes a genuine Playwright-shaped context for site-specific CDP access', async () => {
        const cdpSessions: Page[] = [];
        const contextWithCdp = {
            pages: () => [],
            newPage: async () => fakePage().page,
            close: async () => undefined,
            newCDPSession: async (page: Page) => {
                cdpSessions.push(page);
                return { send: async () => undefined };
            },
        } as unknown as BrowserContext;
        const cdpLauncher: BrowserLauncher = { launch: async () => contextWithCdp };

        await withProfilePage(
            { profileDir: '/tmp/cdp-profile', headless: true, launcher: cdpLauncher },
            async (handle) => {
                await handle.context.newCDPSession(handle.page);
            },
        );

        expect(cdpSessions).toHaveLength(1);
    });

    it('requires the readiness predicate before running the callback; expiry skips the callback and closes', async () => {
        const { launcher, contexts } = fakeLauncher();
        let callbackRan = false;

        const outcome = withProfilePage(
            {
                profileDir: '/tmp/expired-reuse',
                headless: true,
                isAuthenticated: () => false,
                timeoutMs: 0,
                launcher,
            },
            async () => {
                callbackRan = true;
                return 'never';
            },
        );

        expect(outcome).rejects.toThrow(LoginTimeoutError);
        expect(contexts[0]?.closeCalls()).toBe(1);
        expect(callbackRan).toBe(false);
    });

    it('polls until the predicate passes', async () => {
        const { launcher } = fakeLauncher();
        let calls = 0;
        const flakyPredicate = () => {
            calls++;
            return calls >= 2;
        };

        await withProfilePage(
            {
                profileDir: '/tmp/poll-profile',
                headless: true,
                isAuthenticated: flakyPredicate,
                timeoutMs: 5_000,
                launcher,
            },
            async () => undefined,
        );

        expect(calls).toBe(2);
    });

    it('skips predicate polling when none is provided and defaults to headed', async () => {
        const { launcher, requests } = fakeLauncher();

        await withProfilePage({ profileDir: '/tmp/plain-profile', launcher }, async () => undefined);

        expect(requests[0]?.headless).toBe(false);
    });
});
