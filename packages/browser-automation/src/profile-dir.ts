import { isAbsolutePath, resolvePath } from '@gobing-ai/ts-runtime';
import { InvalidProfileDirError } from './errors';

/**
 * Validate a caller-supplied `profileDir` and resolve it to an absolute path
 * (relative inputs resolve against the current working directory). Rejection
 * of empty/blank paths happens here so every operation and launcher entry
 * point behaves identically.
 */
export function resolveProfileDir(profileDir: string): string {
    if (profileDir.trim() === '') {
        throw new InvalidProfileDirError();
    }
    const resolved = resolvePath(profileDir);
    if (!isAbsolutePath(resolved)) {
        throw new InvalidProfileDirError(`profileDir could not be resolved to an absolute path: "${profileDir}".`);
    }
    return resolved;
}
