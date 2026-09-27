/**
 * Typed failure surface for @gobing-ai/ts-browser-automation (task 0088).
 * Each failure mode named in the task (missing/busy profile, auth expiry,
 * timeout, cancellation, missing Playwright) maps to one error class so
 * callers can branch without string matching.
 */

/** Base class for every error this package throws. */
export class BrowserAutomationError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'BrowserAutomationError';
    }
}

/** `profileDir` was empty or blank. */
export class InvalidProfileDirError extends BrowserAutomationError {
    constructor(message = 'profileDir must be a non-empty path to a dedicated browser profile directory.') {
        super(message);
        this.name = 'InvalidProfileDirError';
    }
}

/** A headless run targeted a profile directory that does not exist. */
export class BrowserProfileMissingError extends BrowserAutomationError {
    constructor(profileDir: string) {
        super(
            `Profile directory does not exist: "${profileDir}". Headless runs never create a profile — ` +
                'run loginWithProfile() headed once to create and authenticate it.',
        );
        this.name = 'BrowserProfileMissingError';
    }
}

/** The profile directory is locked by another Chromium instance (singleton rule). */
export class BrowserProfileBusyError extends BrowserAutomationError {
    constructor(profileDir: string, cause: unknown) {
        super(
            `Profile directory is already in use by another browser instance: "${profileDir}". ` +
                'Close the other instance or use a different profileDir — a profile must never be shared by concurrent browsers.',
            { cause },
        );
        this.name = 'BrowserProfileBusyError';
    }
}

/** The `playwright` peer dependency or its Chromium browser is not installed. */
export class PlaywrightUnavailableError extends BrowserAutomationError {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'PlaywrightUnavailableError';
    }
}

/**
 * The caller-owned readiness predicate never passed within the deadline.
 * Recoverable: the message carries the re-login instruction.
 */
export class LoginTimeoutError extends BrowserAutomationError {
    constructor(message: string) {
        super(message);
        this.name = 'LoginTimeoutError';
    }
}

/** The caller aborted the operation via `AbortSignal`. */
export class OperationAbortedError extends BrowserAutomationError {
    constructor(message = 'Browser automation operation was cancelled via AbortSignal.') {
        super(message);
        this.name = 'OperationAbortedError';
    }
}
