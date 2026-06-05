import { getLogger } from '../logger';
import type { EventBus } from './event-bus';
import type { BusLifecycleEvents } from './types';

/**
 * Minimal append-only file writer the file observer needs.
 *
 * ADR-011: ts-infra must not import `node:fs`. The caller injects a writer —
 * typically `@gobing-ai/ts-runtime`'s `FileSystem`, which already satisfies
 * this shape (`ensureDir` + `appendFile`).
 */
export interface FileObserverWriter {
    /** Ensure the directory exists. Called once with the parent dir of the file. */
    ensureDir(dir: string): void | Promise<void>;
    /** Append `content` to `path`, creating the file if absent. */
    appendFile(path: string, content: string): void | Promise<void>;
}

/** Parent directory of a `/`-separated path (no `node:path` dependency). */
function parentDir(filePath: string): string {
    const idx = filePath.lastIndexOf('/');
    return idx <= 0 ? '.' : filePath.slice(0, idx);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return value !== null && typeof value === 'object' && 'then' in value;
}

/**
 * Register handlers on `lifecycleBus` that append structured JSON lines to
 * `filePath` for every lifecycle event.
 *
 * @param lifecycleBus - The bus to observe.
 * @param filePath - Path to the JSONL output file.
 * @param writer - Injected file writer (e.g. ts-runtime `FileSystem`).
 */
export function attachFileObserver(
    lifecycleBus: EventBus<BusLifecycleEvents>,
    filePath: string,
    writer: FileObserverWriter,
): void {
    const logger = getLogger('event-bus.file-observer');
    const ensureResult = writer.ensureDir(parentDir(filePath));
    let ready = !isPromiseLike(ensureResult);
    let pending = isPromiseLike(ensureResult);
    let setupFailed = false;
    let sequence = 0;
    let writeChain: Promise<unknown> = isPromiseLike(ensureResult)
        ? Promise.resolve(ensureResult)
              .then(() => {
                  ready = true;
              })
              .catch((error) => {
                  setupFailed = true;
                  logger.warn('failed to prepare event bus file observer directory', {
                      filePath,
                      error: error instanceof Error ? error.message : String(error),
                  });
              })
        : Promise.resolve();

    function setPending(next: Promise<unknown>): void {
        const current = ++sequence;
        pending = true;
        writeChain = next
            .catch((error) => {
                logger.warn('failed to append event bus lifecycle event', {
                    filePath,
                    error: error instanceof Error ? error.message : String(error),
                });
            })
            .finally(() => {
                if (sequence === current) pending = false;
            });
    }

    function writeLine(line: Record<string, unknown>): void {
        const content = `${JSON.stringify(line)}\n`;
        if (setupFailed) return;

        if (ready && !pending) {
            const result = writer.appendFile(filePath, content);
            if (isPromiseLike(result)) {
                setPending(Promise.resolve(result));
            }
            return;
        }

        setPending(
            writeChain.then(() => {
                if (setupFailed) return;
                return writer.appendFile(filePath, content);
            }),
        );
    }

    lifecycleBus.on('bus.emit.done', (d) => {
        const payload =
            d.detail !== null && typeof d.detail === 'object' && !Array.isArray(d.detail)
                ? (d.detail as Record<string, unknown>)
                : undefined;

        writeLine({
            ts: new Date().toISOString(),
            lifecycle: 'bus.emit.done',
            event: d.event,
            syncCount: d.syncCount,
            asyncCount: d.asyncCount,
            emitDurationMs: d.emitDurationMs,
            errors: d.errors,
            ...(payload && Object.keys(payload).length > 0 ? { payload } : {}),
        });
    });

    lifecycleBus.on('bus.emit.noop', (d) => {
        writeLine({
            ts: new Date().toISOString(),
            lifecycle: 'bus.emit.noop',
            event: d.event,
        });
    });

    lifecycleBus.on('bus.handler.error', (d) => {
        writeLine({
            ts: new Date().toISOString(),
            lifecycle: 'bus.handler.error',
            event: d.event,
            mode: d.mode,
            error: d.error,
        });
    });

    lifecycleBus.on('bus.handler.async.enqueued', (d) => {
        writeLine({
            ts: new Date().toISOString(),
            lifecycle: 'bus.handler.async.enqueued',
            event: d.event,
            jobId: d.jobId,
            handlerCount: d.handlerCount,
        });
    });
}
