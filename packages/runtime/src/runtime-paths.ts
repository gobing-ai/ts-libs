// Injectable cwd/home anchor for runtime seams. Composes {@link getProcessCwd} (path.ts) and
// {@link getHomeDir} (config.ts) so the two owning modules stay focused; this third module is the
// single home for the injectable shape and its ambient factory (ADR-023 A1 / task 0042).

import { getHomeDir } from './config';
import { getProcessCwd } from './path';

/**
 * Injectable cwd/home anchor consumed by runtime seams ({@link createNodeFileSystem},
 * {@link NodeProcessExecutor}, and the JSONL importer's root resolution).
 *
 * Defaults to the ambient process environment via {@link ambientRuntimePaths}; inject a fake
 * in tests or whenever a consumer must not reach for ambient cwd/home state.
 */
export interface RuntimePaths {
    /** Absolute working-directory anchor. */
    readonly cwd: string;
    /** Absolute home-directory anchor. */
    readonly home: string;
}

/**
 * Capture the current ambient {@link RuntimePaths}: `process.cwd()` for `cwd`, and `HOME` /
 * `USERPROFILE` for `home`. When `home` is unset (e.g. on Cloudflare Workers), falls back to
 * `cwd` so the field stays a non-optional absolute anchor — matching the `/`-fallback philosophy
 * of {@link getProcessCwd}: a degraded but always-absolute anchor.
 */
export function ambientRuntimePaths(): RuntimePaths {
    const cwd = getProcessCwd();
    return { cwd, home: getHomeDir() ?? cwd };
}
