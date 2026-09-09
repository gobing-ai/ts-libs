/** Error raised for invalid importer configuration or unsafe generated SQL identifiers. */
export class HistoryImportError extends Error {
    constructor(
        message: string,
        readonly details?: unknown,
    ) {
        super(message);
        this.name = 'HistoryImportError';
    }
}

/**
 * Error raised when a run is cancelled through its {@link ImportOptions.signal} abort signal
 * (feature A21 / ADR-112). Thrown only after in-flight transaction and checkpoint work has
 * settled, so catching it means "cancellation settled — no further writes from this
 * invocation". Incremental resume continues from the last committed checkpoint.
 */
export class ImportCancelledError extends HistoryImportError {
    constructor(
        message = 'Import cancelled by abort signal',
        readonly abortReason?: unknown,
    ) {
        super(message, abortReason);
        this.name = 'ImportCancelledError';
    }
}
