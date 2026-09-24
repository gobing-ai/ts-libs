/**
 * The one-shot `fm` process bridge (task 0084 R4, R5, R7, R8; design § Errors).
 * Argv builders plus run/error mapping. Spawned exclusively through the
 * injected ts-runtime {@link ProcessExecutor} — never `node:child_process`.
 * Prompt and instructions travel as positional arguments because
 * `ProcessExecutor.run` has no stdin input; fm's argv limit is far above the
 * token budget, and the pre-flight `count-tokens` check keeps it bounded.
 */

import {
    DecisionBackendError,
    DecisionConfigError,
    DecisionRequestError,
    DecisionTimeoutError,
} from '@gobing-ai/ts-ai-runner';
import type { ProcessExecutor, ProcessResult } from '@gobing-ai/ts-runtime';

/** `--guardrails` levels accepted by `fm respond` (design: fm CLI facts). */
export type FmGuardrails = 'default' | 'permissive-content-transformations';

/**
 * Subcommand + flag order verified against the design's live observations
 * (task 0086 R4): instructions ride in `--instructions=<value>` and the prompt
 * travels after a `--` separator, so instruction/prompt text can never be
 * reparsed as fm flags regardless of its content.
 */
export function countTokensArgv(instructions: string, prompt: string): string[] {
    return ['count-tokens', '-q', `--instructions=${instructions}`, '--', prompt];
}

/** Builds the `fm respond` argv: schema flag, `--instructions=<instructions>`, `--` separator, positional prompt, optional `-g`/`--guardrails`. */
export function respondArgv(options: {
    schemaPath: string;
    instructions: string;
    prompt: string;
    /** Deterministic mode: single greedy sample. */
    greedy?: boolean;
    /** Omitted ⇒ the flag is omitted (fm's `default`). */
    guardrails?: FmGuardrails;
}): string[] {
    return [
        'respond',
        '--no-stream',
        '--schema',
        options.schemaPath,
        `--instructions=${options.instructions}`,
        ...(options.guardrails !== undefined ? ['--guardrails', options.guardrails] : []),
        ...(options.greedy ? ['-g'] : []),
        '--',
        options.prompt,
    ];
}

/** Bare `fm available` always exits 0 — only `--model system` is a real probe. */
export function availableArgv(): string[] {
    return ['available', '--model', 'system'];
}

/** The executor reports a failed spawn (ENOENT, …) as an `error` outcome. */
function isSpawnFailure(result: ProcessResult): boolean {
    return result.outcome === 'error' && result.exitCode === null;
}

/** fm's own text, preferring stderr, for carrying into error messages. */
function fmText(result: ProcessResult): string {
    const text = (result.stderr.trim().length > 0 ? result.stderr : result.stdout).trim();
    return text.length > 0 ? text : '(no output)';
}

/**
 * R8 prerequisite probe: `fm available --model system`. A spawn failure maps to
 * `DecisionConfigError` "fm not found"; a non-zero exit carries fm's printed
 * reason (e.g. `modelNotReady`). An exit 0 caches availability in the driver.
 * The probe carries `timeoutMs` (task 0086 R12) so a hung fm cannot wedge the
 * driver before the per-sample deadline exists.
 */
export async function probeFmAvailability(
    executor: ProcessExecutor,
    fmPath: string,
    timeoutMs = 10_000,
): Promise<void> {
    const result = await executor.run({ command: fmPath, args: availableArgv(), timeout: timeoutMs });
    if (result.outcome === 'timeout') {
        throw new DecisionTimeoutError(`fm available exceeded requestTimeoutMs (${timeoutMs})`, timeoutMs);
    }
    if (isSpawnFailure(result)) {
        throw new DecisionConfigError(`fm not found: '${fmPath}' could not be spawned`, 'fmPath');
    }
    if (result.exitCode !== 0) {
        throw new DecisionConfigError(`fm system model unavailable: ${fmText(result)}`, 'fm-system-model');
    }
}

/**
 * R4 pre-flight: `fm count-tokens -q --instructions=<instructions> -- <prompt>`
 * prints a bare integer. Non-zero exit or unparseable output is a
 * `DecisionBackendError` — the budget comparison itself happens in the driver.
 * Carries `timeoutMs` (task 0086 R12); a timeout maps to `DecisionTimeoutError`.
 */
export async function countPromptTokens(
    executor: ProcessExecutor,
    fmPath: string,
    instructions: string,
    prompt: string,
    timeoutMs = 10_000,
): Promise<number> {
    const result = await executor.run({
        command: fmPath,
        args: countTokensArgv(instructions, prompt),
        timeout: timeoutMs,
    });
    if (result.outcome === 'timeout') {
        throw new DecisionTimeoutError(`fm count-tokens exceeded requestTimeoutMs (${timeoutMs})`, timeoutMs);
    }
    if (isSpawnFailure(result)) {
        throw new DecisionConfigError(`fm not found: '${fmPath}' could not be spawned`, 'fmPath');
    }
    if (result.exitCode !== 0) {
        throw new DecisionBackendError(
            `fm count-tokens failed (exit ${result.exitCode}): ${fmText(result)}`,
            undefined,
        );
    }
    const tokens = Number.parseInt(result.stdout.trim(), 10);
    if (!Number.isFinite(tokens)) {
        throw new DecisionBackendError(
            `fm count-tokens did not print a token count: ${result.stdout.trim() || '(empty)'}`,
            undefined,
        );
    }
    return tokens;
}

/** Stable substrings of fm's failure text (design § Errors discrimination). */
const CONTEXT_SIZE_MARKER = "exceeded the model's context size";
const GUARDRAILS_MARKER = 'safety guardrails were triggered';

/**
 * One `fm respond` sample: run with the per-sample timeout, map every failure
 * row of the error table, return stdout on success (parsing happens in
 * {@link parseFmRespond}).
 */
export async function runFmRespond(
    executor: ProcessExecutor,
    fmPath: string,
    args: string[],
    requestTimeoutMs: number,
): Promise<string> {
    const result = await executor.run({ command: fmPath, args, timeout: requestTimeoutMs });
    if (result.outcome === 'timeout') {
        // Message deliberately drops the argv — the prompt is user content (task 0086 R12).
        throw new DecisionTimeoutError(
            `fm ${args[0]} exceeded requestTimeoutMs (${requestTimeoutMs})`,
            requestTimeoutMs,
        );
    }
    if (isSpawnFailure(result)) {
        throw new DecisionConfigError(`fm not found: '${fmPath}' could not be spawned`, 'fmPath');
    }
    if (result.exitCode !== 0) {
        const text = fmText(result);
        if (text.includes(CONTEXT_SIZE_MARKER)) {
            throw new DecisionRequestError(`fm prompt exceeded the model context size: ${text}`, undefined, undefined);
        }
        if (text.includes(GUARDRAILS_MARKER)) {
            // Typed failure, never an answer, and the ask is not retried.
            throw new DecisionBackendError(`fm safety guardrails were triggered: ${text}`, undefined);
        }
        throw new DecisionBackendError(`fm respond failed (exit ${result.exitCode}): ${text}`, undefined);
    }
    return result.stdout;
}

/**
 * Parse one sample's stdout as the schema-conformant JSON object. fm prints one
 * JSON object per call, but the key order varies — callers read by key, never
 * by position. Non-JSON or non-object output is a `DecisionBackendError`.
 */
export function parseFmRespond(stdout: string): Record<string, string> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch (cause) {
        throw new DecisionBackendError(`fm respond printed non-JSON output: ${stdout.trim() || '(empty)'}`, undefined, {
            cause,
        });
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new DecisionBackendError(`fm respond printed non-object JSON: ${stdout.trim()}`, undefined);
    }
    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== 'string') {
            throw new DecisionBackendError(`fm respond printed a non-string value for '${key}'`, undefined);
        }
        record[key] = value;
    }
    return record;
}

/** A parsed value outside the declared enum is a schema violation, never an answer (R7). */
export function requireEnumValue(parsed: Record<string, string>, key: string, allowed: readonly string[]): string {
    const value = parsed[key];
    if (value === undefined || !allowed.includes(value)) {
        throw new DecisionBackendError(
            `fm sample for '${key}' violates the schema enum: ${value === undefined ? '(missing)' : `'${value}'`}`,
            undefined,
        );
    }
    return value;
}
