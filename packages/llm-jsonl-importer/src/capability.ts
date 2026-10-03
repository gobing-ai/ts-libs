/**
 * Capability-origin classification helpers (E93 task 1028).
 *
 * Pure helpers shared by the per-source skill-call detectors in `./mappers` and validated
 * at the importer boundary. Two responsibilities:
 *
 * 1. **Origin matching** — a `history_skill_call` row's `capability_kind`/`origin_identity`
 *    is established by (a) native source identity (a command expansion envelope, a native
 *    command record, a delegation record) or (b) a unique supplied {@link CapabilityOrigin}
 *    whose source, canonical name, optional exact path and observed complete-artifact
 *    digest agree with the invoking record. Never from a name prefix, invocation
 *    restriction or marker spelling alone; conflicts classify as unknown and surface a
 *    bounded finding rather than guessing.
 * 2. **Bounded literal grammars** — shell `cat [--] <path...>` / `sed -n '<range>p' <path>`
 *    read commands and nested `tools.exec_command({cmd: <literal>})` payloads are parsed as
 *    strict literal shapes only: quote-honoring, comment/quoted-code aware, rejecting
 *    expansions, substitutions and redirections. Anything outside the grammar yields no
 *    capability fact (an ordinary tool call), never a guess.
 */
import { HistoryImportError } from './errors';
import { sha256Text } from './hash';
import type { CapabilityKind, CapabilityOrigin } from './types';

/** Result of matching a record's observable identity against the supplied origin index. */
export interface CapabilityOriginMatch {
    /** The unique agreeing origin, or null when nothing agreed. */
    readonly origin: CapabilityOrigin | undefined;
    /** Human-readable conflict reason when candidate origins disagreed (never a guess). */
    readonly conflict: string | null;
}

const CAPABILITY_KINDS: readonly CapabilityKind[] = ['command', 'subagent', 'skill'];
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** Validate operator-supplied capability origins before the importer opens any write path. */
export function validateCapabilityOrigins(input: readonly CapabilityOrigin[] | undefined): readonly CapabilityOrigin[] {
    if (input === undefined) return [];
    if (!Array.isArray(input)) {
        throw new HistoryImportError('capabilityOrigins must be an array of CapabilityOrigin objects.', {
            option: 'capabilityOrigins',
        });
    }
    return input.map((origin, index) => {
        const fail = (reason: string): never => {
            throw new HistoryImportError(`capabilityOrigins[${index}]: ${reason}`, {
                option: 'capabilityOrigins',
                index,
            });
        };
        if (typeof origin !== 'object' || origin === null) fail('entry must be an object.');
        if (typeof origin.source !== 'string' || origin.source.trim() === '')
            fail('source must be a non-empty string.');
        if (typeof origin.skillName !== 'string' || origin.skillName.trim() === '') {
            fail('skillName must be a non-empty string.');
        }
        if (typeof origin.artifactDigest !== 'string' || !DIGEST_PATTERN.test(origin.artifactDigest)) {
            fail('artifactDigest must be a 64-character lowercase hex SHA-256 string.');
        }
        if (!CAPABILITY_KINDS.includes(origin.capabilityKind)) {
            fail(`capabilityKind must be one of ${CAPABILITY_KINDS.map((k) => `'${k}'`).join(', ')}.`);
        }
        if (typeof origin.originIdentity !== 'string' || origin.originIdentity.trim() === '') {
            fail('originIdentity must be a non-empty string.');
        }
        if (
            origin.skillPath !== undefined &&
            (typeof origin.skillPath !== 'string' || origin.skillPath.trim() === '')
        ) {
            fail('skillPath must be a non-empty string when present.');
        }
        return origin;
    });
}

/**
 * Match one invoking record against the supplied origin index for its source.
 *
 * Agreement is required on every observable dimension: canonical name always; exact path
 * when the record observed one; complete-artifact digest when the record carried the full
 * injected body. Name+path narrowing first, then digest filtering; zero matches resolve to
 * unknown (no origin), more than one to a conflict. Pure — no persistence.
 */
export function matchCapabilityOrigin(
    origins: readonly CapabilityOrigin[],
    source: string,
    canonicalName: string,
    observable: { skillPath?: string | null; artifactDigest?: string | null },
): CapabilityOriginMatch {
    let candidates = origins.filter((origin) => origin.source === source && origin.skillName === canonicalName);
    if (candidates.length === 0) return { origin: undefined, conflict: null };
    if (observable.skillPath != null && observable.skillPath !== '') {
        const byPath = candidates.filter(
            (origin) => origin.skillPath !== undefined && origin.skillPath === observable.skillPath,
        );
        if (byPath.length > 0) candidates = byPath;
    }
    if (observable.artifactDigest != null && observable.artifactDigest !== '') {
        const byDigest = candidates.filter((origin) => origin.artifactDigest === observable.artifactDigest);
        if (byDigest.length === 1) return { origin: byDigest[0], conflict: null };
        if (byDigest.length > 1) {
            return {
                origin: undefined,
                conflict: `capabilityOrigins: ${byDigest.length} origins agree on digest for '${canonicalName}'.`,
            };
        }
        return {
            origin: undefined,
            conflict: `capabilityOrigins: observed artifact digest does not match the supplied origin for '${canonicalName}'.`,
        };
    }
    if (candidates.length === 1) return { origin: candidates[0], conflict: null };
    return {
        origin: undefined,
        conflict: `capabilityOrigins: ${candidates.length} origins match '${canonicalName}' without distinguishing evidence.`,
    };
}

/** Stable version-1 invocation-identity tuple → `invocation_id` (E93 §8.2). */
export function capabilityInvocationId(parts: {
    source: string;
    sessionId: string;
    kind: 'invocation' | 'call' | 'record' | 'line';
    id?: string;
    ordinal?: number;
    file?: string;
    line?: number;
}): string {
    return sha256Text(
        JSON.stringify(
            {
                domain: 'capability-invocation',
                v: 1,
                source: parts.source,
                sessionId: parts.sessionId,
                kind: parts.kind,
                id: parts.id ?? null,
                ordinal: parts.ordinal ?? null,
                file: parts.file ?? null,
                line: parts.line ?? null,
            },
            Object.keys({
                domain: 0,
                v: 0,
                source: 0,
                sessionId: 0,
                kind: 0,
                id: 0,
                ordinal: 0,
                file: 0,
                line: 0,
            }).sort(),
        ),
    );
}

// ---------------------------------------------------------------------------
// Shell literal grammar — `cat [--] <path...>` and `sed -n '<range>p' <path>`
// ---------------------------------------------------------------------------

/** Result tokens of one quote-honoring shell scan. */
interface ShellScan {
    readonly tokens: readonly string[];
    /** True when the scan saw expansion/substitution/escape syntax outside quotes. */
    readonly dynamic: boolean;
}

/**
 * Tokenize one command segment honoring single/double quotes. Inside double quotes,
 * `$`/backtick mark the whole segment dynamic (expansion). Backslash escapes outside
 * quotes mark it dynamic too — the bounded grammar only trusts plain literals.
 */
function scanShellSegment(segment: string): ShellScan {
    const tokens: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    let dynamic = false;
    for (let i = 0; i < segment.length; i += 1) {
        const ch = segment[i];
        if (quote === "'") {
            if (ch === "'") quote = null;
            else current += ch;
            continue;
        }
        if (quote === '"') {
            if (ch === '"') quote = null;
            else if (ch === '$' || ch === '`') dynamic = true;
            else current += ch;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            continue;
        }
        if (ch === '\\' || ch === '$' || ch === '`') {
            dynamic = true;
            continue;
        }
        if (ch === ' ' || ch === '\t' || ch === '\n') {
            if (current !== '') tokens.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    if (quote !== null) dynamic = true; // unterminated quote — torn or foreign line
    if (current !== '') tokens.push(current);
    return { tokens, dynamic };
}

/** Split a command string into segments at top-level `&&`, `||`, `;` and `|` separators. */
function splitShellSegments(command: string): readonly string[] {
    const segments: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    for (let i = 0; i < command.length; i += 1) {
        const ch = command[i];
        if (quote !== null) {
            current += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === ';') {
            segments.push(current);
            current = '';
            continue;
        }
        if (ch === '|' || ch === '&') {
            if (command[i + 1] === ch) {
                segments.push(current);
                current = '';
                i += 1;
                continue;
            }
            segments.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    segments.push(current);
    return segments;
}

/** Final path segment of a candidate read target, or null. */
function lastPathSegment(path: string): string {
    const trimmed = path.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** A `sed -n` arg is a print range only when it is a pure line-address print form. */
function isSedPrintRange(token: string): boolean {
    return /^\$?[0-9]+(\s*,\s*(\$|[0-9]+))?p$/.test(token) || /^\$p$/.test(token);
}

/** Does a segment contain a redirection operator outside quotes? */
function hasRedirection(segment: string): boolean {
    let quote: '"' | "'" | null = null;
    for (let i = 0; i < segment.length; i += 1) {
        const ch = segment[i];
        if (quote !== null) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            continue;
        }
        if (ch === '>' || ch === '<') return true;
    }
    return false;
}

/**
 * Extract SKILL.md read targets from one literal shell command (E93 §8.2).
 *
 * Accepts only literal `cat [-n...] [--] <path...>` and `sed -n <range>... <path>` forms
 * whose final segment resolves to a `SKILL.md` file. Expansions (`$`, backticks, escapes),
 * redirections, multiple commands per argument and anything non-literal yield no targets.
 */
export function parseLiteralReadTargets(command: string): readonly string[] {
    if (typeof command !== 'string' || command.trim() === '') return [];
    const targets: string[] = [];
    for (const segment of splitShellSegments(command)) {
        if (segment.trim() === '' || hasRedirection(segment)) continue;
        const trimmed = segment.trim();
        if (trimmed.startsWith('#')) continue; // comment line
        const scan = scanShellSegment(trimmed);
        if (scan.dynamic || scan.tokens.length === 0) continue;
        const [cmd, ...args] = scan.tokens;
        if (cmd === 'cat') {
            for (const arg of args) {
                if (arg === '--') continue; // end-of-options marker is literal-safe
                if (arg.startsWith('-')) continue; // options like -n
                if (lastPathSegment(arg) === 'SKILL.md') targets.push(arg);
            }
            continue;
        }
        if (cmd === 'sed') {
            let sawNoPrint = false;
            const rangeArgs: string[] = [];
            for (const arg of args) {
                if (arg === '--') continue;
                if (arg === '-n' || arg === '--quiet' || arg === '--silent') {
                    sawNoPrint = true;
                    continue;
                }
                if (arg.startsWith('-')) {
                    sawNoPrint = false; // any other flag leaves the bounded print form
                    break;
                }
                if (isSedPrintRange(arg)) {
                    rangeArgs.push(arg);
                    continue;
                }
                // First non-range non-flag arg: the path. Exactly one, after ranges.
                if (rangeArgs.length === 0) {
                    sawNoPrint = false;
                    break;
                }
                if (sawNoPrint && lastPathSegment(arg) === 'SKILL.md') targets.push(arg); // only the -n print form
                break; // only one path per sed invocation
            }
            if (!sawNoPrint) continue;
        }
    }
    return targets;
}

/**
 * Extract literal command strings from nested `tools.exec_command({cmd: <literal>, ...})`
 * payloads (E93 §8.2 — codex `functions.exec` bodies).
 *
 * Strict shape: `cmd` as the first key with a plain single/double-quoted string literal;
 * any further keys must be plain literals; no template literals, concatenation or
 * expansions. Matches must start a statement (after whitespace, `{`, `;` or `}`) so the
 * same text quoted inside a larger string is not code; whole-line and block comments are
 * skipped.
 */
export function extractNestedExecCommandLiterals(payloadText: string): readonly string[] {
    if (typeof payloadText !== 'string' || payloadText.trim() === '') return [];
    const literals: string[] = [];
    const shape =
        /tools\.exec_command\(\s*\{\s*cmd:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')((?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[-0-9.eE+]+|true|false|null))*)\s*\}\s*\)/g;
    let inBlockComment = false;
    for (const rawLine of payloadText.split(/\r?\n/)) {
        let line = rawLine;
        if (inBlockComment) {
            const end = line.indexOf('*/');
            if (end === -1) continue;
            line = line.slice(end + 2);
            inBlockComment = false;
        }
        // Strip whole-line comments; a line that opens a block comment contributes only its prefix.
        const trimmedStart = line.trimStart();
        if (trimmedStart.startsWith('//')) continue;
        const blockStart = line.indexOf('/*');
        if (blockStart !== -1) {
            const end = line.indexOf('*/', blockStart + 2);
            line = end === -1 ? line.slice(0, blockStart) : line.slice(0, blockStart) + line.slice(end + 2);
            if (end === -1) inBlockComment = true;
        }
        const statementStart = /(?:^|[{};])\s*$/; // match must follow whitespace or a statement boundary
        shape.lastIndex = 0;
        let match: RegExpExecArray | null = shape.exec(line);
        while (match !== null) {
            const before = line.slice(0, match.index);
            if (statementStart.test(before)) {
                const literal: string = match[1] ?? '';
                const quote: string = literal[0] ?? '"';
                const body = literal
                    .slice(1, -1)
                    .replaceAll(`\\${quote}`, quote)
                    .replaceAll('\\\\', '\\')
                    .replaceAll('\\n', '\n')
                    .replaceAll('\\t', '\t');
                literals.push(body);
            }
            match = shape.exec(line);
        }
    }
    return literals;
}
