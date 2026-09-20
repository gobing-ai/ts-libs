/**
 * `DecisionError` taxonomy. Both the facade and the driver throw from this set;
 * no raw SDK error class escapes the package. Keeping every class in one file
 * makes that invariant checkable by reading a single file.
 */

/** Base class for every decision-surface error. */
export class DecisionError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = new.target.name;
    }
}

/** Missing configuration — e.g. no `TYPESAFE_API_KEY` in the injected env. Carries the variable name. */
export class DecisionConfigError extends DecisionError {
    constructor(
        message: string,
        readonly variable: string,
        options?: { cause?: unknown },
    ) {
        super(message, options);
    }
}

/** Authentication or permission failure upstream. Carries the HTTP status. */
export class DecisionAuthError extends DecisionError {
    constructor(
        message: string,
        readonly status: number | undefined,
        options?: { cause?: unknown },
    ) {
        super(message, options);
    }
}

/** Rate limited upstream. Carries the status and the parsed retry-after hint. */
export class DecisionRateLimitError extends DecisionError {
    constructor(
        message: string,
        readonly status: number | undefined,
        readonly retryAfterMs: number | undefined,
        options?: { cause?: unknown },
    ) {
        super(message, options);
    }
}

/** Request timed out. Carries the configured timeout in milliseconds. */
export class DecisionTimeoutError extends DecisionError {
    constructor(
        message: string,
        readonly timeoutMs: number | undefined,
        options?: { cause?: unknown },
    ) {
        super(message, options);
    }
}

/** The backend was unreachable. Carries the underlying cause. */
export class DecisionConnectionError extends DecisionError {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
    }
}

/** The request was rejected as malformed (4xx other than auth/rate-limit). Carries status and a body summary. */
export class DecisionRequestError extends DecisionError {
    constructor(
        message: string,
        readonly status: number | undefined,
        readonly bodySummary: string | undefined,
        options?: { cause?: unknown },
    ) {
        super(message, options);
    }
}

/** Upstream server failure (5xx). Carries the HTTP status. */
export class DecisionBackendError extends DecisionError {
    constructor(
        message: string,
        readonly status: number | undefined,
        options?: { cause?: unknown },
    ) {
        super(message, options);
    }
}
