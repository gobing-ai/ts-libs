import { ImportCancelledError } from './errors';

/**
 * Cooperative cancellation boundary (feature A21 / ADR-112). Call it only at safe
 * boundaries — before starting further asynchronous work or writes — so any in-flight
 * batch settles first and the public promise can never reject ahead of its own writes.
 * Synchronous SQLite work cannot be interrupted here; the containing process remains
 * the hard fallback for blocking work.
 */
export function throwIfImportAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw new ImportCancelledError('Import cancelled by abort signal', signal.reason);
    }
}
