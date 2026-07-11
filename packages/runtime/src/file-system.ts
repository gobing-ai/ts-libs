/** Portable file stat subset. */
export interface FileStat {
    isFile(): boolean;
    isDirectory(): boolean;
    size: number;
    mtimeMs: number;
}

/**
 * Runtime-agnostic file system abstraction.
 *
 * Bun/Node backend uses `node:fs`. Cloudflare Workers backend provides stubs
 * that throw clear "not available" errors, directing developers to use D1,
 * KV, or R2 for persistent storage.
 *
 * All code outside `packages/runtime/src/file-system*.ts` MUST use this
 * interface — never import `node:fs` or call `Bun.write`/`Bun.file` directly.
 */
export interface FileSystem {
    /** Check whether a path exists. */
    exists(path: string): boolean | Promise<boolean>;

    /** Read file contents as UTF-8 string. Throws if not found. */
    readFile(path: string): string | Promise<string>;
    /**
     * Read file contents as a stream of UTF-8 text lines.
     *
     * Returns an async iterable yielding one line per iteration (without
     * trailing newline). This is the streaming counterpart of `readFile`
     * for large files that should not be loaded into memory all at once.
     *
     * Optional: Cloudflare Workers and other stubs may omit this method.
     * Callers must check for its presence before use and fall back to
     * `readFile` + `split` when unavailable.
     */
    readFileStream?(path: string): AsyncIterable<string>;

    /** Write file contents, creating parent directories as needed. */
    writeFile(path: string, content: string): void | Promise<void>;

    /** Append content to a file, creating it if it doesn't exist. */
    appendFile(path: string, content: string): void | Promise<void>;

    /** Ensure a directory exists, creating it (and parents) recursively if needed. */
    ensureDir(path: string): void | Promise<void>;

    /** List directory entries (names only, not full paths). */
    readDir(path: string): string[] | Promise<string[]>;

    /** Delete a file or directory recursively. */
    deleteFile(path: string): void | Promise<void>;

    /** Atomically rename a file or directory. */
    rename(src: string, dest: string): void | Promise<void>;

    /** Recursively copy a file or directory. */
    copy(src: string, dest: string): void | Promise<void>;
    /** Get file or directory stats. Returns `null` if the path doesn't exist. */
    stat(path: string): FileStat | null | Promise<FileStat | null>;

    /** Create a writable stream for append-only output (Node/Bun only). Throws on CF Workers. */
    createWriteStream(path: string): { write(chunk: string): void; end(): void };

    /**
     * Resolve the canonical (symlink-free) absolute path.
     *
     * WHY: used by the extension loader (ADR-022) to verify that an extension
     * module's real path — after following symlinks — still falls within its
     * declaring `baseDir`. Without this, a symlink can bypass the string-level
     * `..` guard and load code from outside the intended directory.
     *
     * Optional: stubs without a real filesystem (e.g. CF Workers) may omit this.
     * When absent, the extension loader skips the symlink confinement check.
     */
    realPath?(path: string): string;

    /** Resolve path segments relative to the project root. */
    resolve(...segments: string[]): string;

    /** Get the project root directory path. */
    getProjectRoot(): string;
}
