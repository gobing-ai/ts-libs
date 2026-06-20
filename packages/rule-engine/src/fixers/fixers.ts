/**
 * Core fixer pipeline: built-in fixer implementations,
 * and the byte-range fix application function.
 *
 * @module rule-engine/fixers
 */

import {
    createNodeFileSystem,
    type FileSystem,
    isAbsolutePath,
    joinPath,
    type ProcessExecutor,
    relativePath,
    resolvePath,
} from '@gobing-ai/ts-runtime';
import type { RuleEngineHost } from '../host/rule-engine-host';
import type { ConstraintRule, Fix, FixMode, RuleFixerInput, RuleFixerProvider } from '../types';
import { TestStubFixer } from './test-stub-fixer';

// Re-export types that moved to ../types — consumers import them from the barrel.
export type { EffectiveFix, RuleFixerInput, RuleFixerProvider } from '../types';

/** Numeric ordering for fix authority; higher means more write authority. */
export const FIX_MODE_RANK: Record<FixMode, number> = {
    none: 0,
    suggest: 1,
    auto: 2,
};

/** Result of applying or previewing a batch of fixes. */
export interface FixApplicationResult {
    /** Files changed in memory or on disk. */
    readonly changedFiles: string[];
    /** Fixes successfully applied. */
    readonly applied: Fix[];
    /** Fixes skipped because they overlapped an already-applied edit. */
    readonly deferred: Fix[];
    /** Unified diff when dry-run mode is requested. */
    readonly diff: string;
}

/** Register built-in fixer providers into the host's fixer registry. */
export function registerBuiltinFixers(host: RuleEngineHost, exec?: ProcessExecutor): void {
    const regexFixer = new RegexFixerProvider();
    const pathFixer = new PathFixerProvider();
    host.fixers.register('regex', regexFixer, 'builtin');
    host.fixers.register('rg', regexFixer, 'builtin');
    host.fixers.register('path', pathFixer, 'builtin');
    host.fixers.register('file-exist', pathFixer, 'builtin');
    if (exec) {
        host.fixers.register(
            'test-location',
            new TestStubFixer({ resolvers: host.resolvers, processExecutor: exec }),
            'builtin',
        );
    }
}

/** Resolve a workdir-relative or absolute path to an absolute path. */
export function resolveWorkdirPath(workdir: string, filePath: string): string {
    return isAbsolutePath(filePath) ? filePath : joinPath(workdir, filePath);
}

/** Apply byte-range fixes to files, optionally returning a dry-run diff only. */
export async function applyFixes(
    workdir: string,
    fixes: readonly Fix[],
    dryRun = false,
    fs: FileSystem = createNodeFileSystem(),
): Promise<FixApplicationResult> {
    const byFile = new Map<string, Fix[]>();
    for (const fix of fixes) {
        const list = byFile.get(fix.filePath) ?? [];
        list.push(fix);
        byFile.set(fix.filePath, list);
    }

    const applied: Fix[] = [];
    const deferred: Fix[] = [];
    const changedFiles: string[] = [];
    const diffs: string[] = [];

    for (const [filePath, fileFixes] of byFile) {
        const absPath = resolveWorkdirPath(workdir, filePath);
        if (!isInsideWorkdir(workdir, absPath)) {
            deferred.push(...fileFixes);
            continue;
        }

        const fileExists = await fs.exists(absPath);
        const original = fileExists ? await fs.readFile(absPath) : '';
        const selected = selectNonOverlappingFixes(fileFixes);
        deferred.push(...selected.deferred);

        let next = original;
        for (const fix of [...selected.applied].sort((a, b) => b.start - a.start)) {
            if (!fileExists && (fix.start !== 0 || fix.end !== 0)) {
                deferred.push(fix);
                continue;
            }
            if (!isValidRange(fix.start, fix.end, original.length)) {
                deferred.push(fix);
                continue;
            }
            next = `${next.slice(0, fix.start)}${fix.replacement}${next.slice(fix.end)}`;
            applied.push(fix);
        }

        if (next === original) {
            continue;
        }

        changedFiles.push(filePath);
        diffs.push(createUnifiedDiff(filePath, original, next));

        if (!dryRun) {
            const isFullDeletion =
                next.length === 0 && selected.applied.some((fix) => fix.start === 0 && fix.end === original.length);
            if (isFullDeletion) {
                await fs.deleteFile(absPath);
            } else {
                await fs.writeFile(absPath, next);
            }
        }
    }

    return { changedFiles, applied, deferred, diff: diffs.join('\n') };
}

/** Create a coarse unified diff string for dry-run CLI output. */
export function createUnifiedDiff(filePath: string, before: string, after: string): string {
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    const lines = [`--- ${filePath}`, `+++ ${filePath}`, `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`];
    lines.push(...beforeLines.map((line) => `-${line}`));
    lines.push(...afterLines.map((line) => `+${line}`));
    return lines.join('\n');
}

/** Select the maximal non-overlapping set of fixes, ordered by ascending start offset. */
function selectNonOverlappingFixes(fixes: readonly Fix[]): { applied: Fix[]; deferred: Fix[] } {
    const applied: Fix[] = [];
    const deferred: Fix[] = [];
    const ordered = [...fixes].sort((a, b) => a.start - b.start || a.end - b.end);
    let lastEnd = -1;
    for (const fix of ordered) {
        if (fix.start < lastEnd) {
            deferred.push(fix);
            continue;
        }
        applied.push(fix);
        lastEnd = fix.end;
    }
    return { applied, deferred };
}

/** Return true when absPath is at or below workdir. */
function isInsideWorkdir(workdir: string, absPath: string): boolean {
    const rel = relativePath(resolvePath(workdir), resolvePath(absPath));
    return rel === '' || (!rel.startsWith('..') && !isAbsolutePath(rel));
}

/** Return true when [start, end] is a valid byte range for a string of contentLength bytes. */
function isValidRange(start: number, end: number, contentLength: number): boolean {
    return start >= 0 && end >= start && end <= contentLength;
}

/**
 * Fixer provider for `regex` / `rg` evaluators.
 *
 * For each finding with a known line number, reads the file and emits a Fix that
 * replaces every regex match on that line using `rule.fix.replacement` as the
 * replacement string (supports `$1` / `$&` back-references).
 */
export class RegexFixerProvider implements RuleFixerProvider {
    /** Produce fixes for regex-evaluator findings. */
    async createFixes({ rule, context, findings, fix }: RuleFixerInput): Promise<Fix[]> {
        const fs = context.fileSystem ?? createNodeFileSystem();

        if (fix.mode === 'none' || fix.replacement === undefined) return [];
        // After the guard above, mode is guaranteed to not be 'none'.
        const fixMode = fix.mode as Exclude<FixMode, 'none'>;
        const replacement = fix.replacement;
        const pattern = rule.evaluator.config?.pattern;
        if (typeof pattern !== 'string' || pattern.length === 0) return [];
        const flags = flagsFromRule(rule);
        const regex = new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);

        const fixes: Fix[] = [];
        for (const finding of findings) {
            if (!finding.filePath) continue;
            const absPath = resolveWorkdirPath(context.workdir, finding.filePath);
            if (!isInsideWorkdir(context.workdir, absPath) || finding.line == null) continue;
            if (!(await fs.exists(absPath))) continue;
            const source = await fs.readFile(absPath);
            const line = getLineRange(source, finding.line);
            if (!line) continue;
            for (const match of source.slice(line.start, line.end).matchAll(regex)) {
                if (match.index === undefined) continue;
                const matched = match[0];
                fixes.push({
                    ruleId: rule.id,
                    filePath: finding.filePath,
                    start: line.start + match.index,
                    end: line.start + match.index + matched.length,
                    replacement: matched.replace(new RegExp(pattern, flags), replacement),
                    mode: fixMode,
                });
            }
        }
        return fixes;
    }
}

/**
 * Fixer provider for `path` / `file-exist` evaluators.
 *
 * In `auto` mode, when a rule requires a file to be absent (`must: absent`),
 * emits a Fix that replaces the entire file content with an empty string.
 * `applyFixes` interprets a zero-length result spanning the full file as a deletion.
 */
export class PathFixerProvider implements RuleFixerProvider {
    /** Produce deletion fixes for path-evaluator findings. */
    async createFixes({ rule, context, findings, fix }: RuleFixerInput): Promise<Fix[]> {
        const fs = context.fileSystem ?? createNodeFileSystem();
        if (fix.mode !== 'auto' || rule.evaluator.config?.must !== 'absent') return [];
        const fixes: Fix[] = [];
        for (const finding of findings) {
            if (!finding.filePath) continue;
            const absPath = resolveWorkdirPath(context.workdir, finding.filePath);
            if (!(await fs.exists(absPath))) continue;
            const content = await fs.readFile(absPath);
            fixes.push({
                ruleId: rule.id,
                filePath: finding.filePath,
                start: 0,
                end: content.length,
                replacement: '',
                mode: 'auto' as const,
            });
        }
        return fixes;
    }
}

/** Extract regex flags from a rule's evaluator config. */
function flagsFromRule(rule: ConstraintRule): string {
    const raw = rule.evaluator.config?.flags;
    if (typeof raw !== 'string') return '';
    if (raw.startsWith('(?') && raw.endsWith(')')) {
        return raw.slice(2, -1).replace(/[^imsuy]/g, '');
    }
    return raw.replace(/[^imsuy]/g, '');
}

/** Return the byte range [start, end) of a one-based line number within source. */
function getLineRange(source: string, oneBasedLine: number): { start: number; end: number } | null {
    if (oneBasedLine < 1) return null;
    let start = 0;
    for (let line = 1; line < oneBasedLine; line += 1) {
        const next = source.indexOf('\n', start);
        if (next === -1) return null;
        start = next + 1;
    }
    const newline = source.indexOf('\n', start);
    return { start, end: newline === -1 ? source.length : newline };
}
