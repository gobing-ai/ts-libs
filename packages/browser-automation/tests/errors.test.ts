import { describe, expect, it } from 'bun:test';
import {
    BrowserAutomationError,
    BrowserProfileBusyError,
    BrowserProfileMissingError,
    InvalidProfileDirError,
    LoginTimeoutError,
    OperationAbortedError,
    PlaywrightUnavailableError,
} from '../src/errors';

describe('typed error surface (task 0088 R2-R4)', () => {
    it('derives every subclass from BrowserAutomationError with its own name', () => {
        const errors = [
            new InvalidProfileDirError(),
            new BrowserProfileMissingError('/tmp/p'),
            new BrowserProfileBusyError('/tmp/p', new Error('locked')),
            new PlaywrightUnavailableError('missing peer'),
            new LoginTimeoutError('expired'),
            new OperationAbortedError(),
        ];

        for (const error of errors) {
            expect(error).toBeInstanceOf(BrowserAutomationError);
            expect(error.name).not.toBe('BrowserAutomationError');
            expect(error.name).not.toBe('Error');
        }
    });

    it('rejects empty profile paths with the default message', () => {
        expect(new InvalidProfileDirError().message).toMatch(/non-empty/);
    });

    it('names the missing profile directory and points at the headed login', () => {
        const error = new BrowserProfileMissingError('/tmp/absent-profile');
        expect(error.message).toContain('/tmp/absent-profile');
        expect(error.message).toMatch(/loginWithProfile/);
    });

    it('preserves the cause of a busy-profile failure', () => {
        const cause = new Error('ProcessSingleton failed');
        const error = new BrowserProfileBusyError('/tmp/busy-profile', cause);
        expect(error.cause).toBe(cause);
        expect(error.message).toContain('/tmp/busy-profile');
    });

    it('preserves the cause of a Playwright availability failure', () => {
        const cause = new Error("Cannot find module 'playwright'");
        const error = new PlaywrightUnavailableError('peer missing', { cause });
        expect(error.cause).toBe(cause);
    });

    it('carries the recoverable re-login instruction on login timeout', () => {
        const error = new LoginTimeoutError(
            'Authentication was not confirmed within 1000ms. Re-run loginWithProfile() with the same profileDir to sign in again.',
        );
        expect(error.message).toMatch(/loginWithProfile/);
        expect(error.message).toMatch(/sign in again/);
    });

    it('defaults the cancellation message to the AbortSignal wording', () => {
        expect(new OperationAbortedError().message).toMatch(/AbortSignal/);
    });
});
