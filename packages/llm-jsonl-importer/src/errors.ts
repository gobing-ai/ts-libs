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
