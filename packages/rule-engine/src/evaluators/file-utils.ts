/**
 * Aggregating barrel for evaluator file utilities — kept so existing imports
 * (`./file-utils`) stay stable. The implementation now lives in three focused
 * modules by concern:
 *
 * - `./glob-match`      — path-pattern matching (`matchesAny`, `matchesGlob`, `escapeRegExp`)
 * - `./file-discovery`  — directory walks, scope filtering, per-file reads
 * - `./config-access`   — typed `evaluator.config` accessors + inline-flag parsing
 *
 * Prefer importing from the specific module in new code; this barrel exists for
 * back-compat and as a convenience surface.
 */

export {
    type ConfigAccessorOptions,
    configArray,
    configNumber,
    configString,
    parseInlineFlags,
    stringArray,
} from './config-access';
export {
    DEFAULT_EXCLUDES,
    discoverFiles,
    readWorkdirFile,
    relativeParent,
    relativeToWorkdir,
    type ScanFilesOptions,
    type ScanMatchMode,
    type ScannedFile,
    type SourceDiscoveryOptions,
    scanFiles,
} from './file-discovery';
export { escapeRegExp, matchesAny, matchesGlob } from './glob-match';
