/**
 * The Apple `fm` decision driver (task 0084 R2, R8, R9; design § Main export).
 * Satisfies the same {@link DecisionDriver} contract as the other backends over
 * one-shot `fm` processes: one schema per ask answers the whole question map,
 * probabilities come from k sample frequencies (ADR-030), and every failure
 * surfaces through the decision error taxonomy — never as an answer.
 */

import {
    type Answer,
    DecisionConfigError,
    type DecisionDriver,
    DecisionRequestError,
    type DecisionState,
    type Question,
} from '@gobing-ai/ts-ai-runner';
import {
    createNodeFileSystem,
    getProcessEnv,
    joinPath,
    nodeBunFactory,
    type ProcessExecutor,
} from '@gobing-ai/ts-runtime';
import { estimateChoice, estimateNoul, estimateScore } from './estimate';
import {
    countPromptTokens,
    type FmGuardrails,
    parseFmRespond,
    probeFmAvailability,
    requireEnumValue,
    respondArgv,
    runFmRespond,
} from './fm-process';
import { buildFmSchema, buildPrompt, declaredOptions, FM_INSTRUCTIONS } from './schema';

/** Configuration options for {@link createFmDriver}. */
export interface FmDriverOptions {
    /** Samples per ask. Default: 5. Ignored when `deterministic` is true. */
    samples?: number;
    /** One greedy sample (`fm respond -g`); probabilities are one-hot. Default: false. */
    deterministic?: boolean;
    /** Prompt-token budget checked with `fm count-tokens` before sampling. Default: 6_000. */
    maxPromptTokens?: number;
    /** Budget for one `fm respond` process. Default: 30_000. */
    requestTimeoutMs?: number;
    /** `--guardrails` level. Default: omitted (fm's `default`). */
    guardrails?: FmGuardrails;
    /** Executable. Default: 'fm'. */
    fmPath?: string;
    /** Injected process seam. Default: ts-runtime's ProcessExecutor. */
    executor?: ProcessExecutor;
    /** Host platform, injectable so tests pin the host. Default: `process.platform` (as laya-mlx). */
    platform?: string;
    /** Host architecture. Default: `process.arch`. */
    arch?: string;
}

/** The fm driver: a {@link DecisionDriver} with a declared estimator (ADR-030). */
export interface FmDecisionDriver extends DecisionDriver {
    readonly name: 'fm-local';
    /** Declared estimator — how every probability this driver returns was produced. */
    readonly estimator: { readonly kind: 'sample-frequency'; readonly samples: number; readonly greedy: boolean };
}

/**
 * Build the `fm-local` decision driver. Host platform/architecture is checked
 * here, at construction, without spawning (R8); the `fm` availability probe
 * runs once, on the first `ask`, and is cached for the driver's lifetime.
 */
export function createFmDriver(options: FmDriverOptions = {}): FmDecisionDriver {
    const {
        samples = 5,
        deterministic = false,
        maxPromptTokens = 6_000,
        requestTimeoutMs = 30_000,
        guardrails,
        fmPath = 'fm',
        executor = nodeBunFactory.createProcessExecutor(),
        platform = process.platform,
        arch = process.arch,
    } = options;

    if (!Number.isInteger(samples) || samples < 1) {
        throw new DecisionRequestError(`samples must be a positive integer; got ${samples}`, undefined, undefined);
    }
    const k = deterministic ? 1 : samples;

    if (platform !== 'darwin' || arch !== 'arm64') {
        throw new DecisionConfigError(
            `decision-fm requires macOS on Apple Silicon (darwin arm64); current platform is '${platform} ${arch}'`,
            'PLATFORM',
        );
    }

    const fs = createNodeFileSystem();
    let availabilityVerified = false;

    async function ensureFmAvailable(): Promise<void> {
        if (availabilityVerified) return;
        await probeFmAvailability(executor, fmPath);
        availabilityVerified = true;
    }

    return {
        name: 'fm-local',
        estimator: { kind: 'sample-frequency', samples: k, greedy: deterministic },

        async ask({
            state,
            questions,
            model,
        }: {
            state: DecisionState;
            questions: Record<string, Question>;
            model?: string;
        }): Promise<Record<string, Answer>> {
            // R9: only the on-device system model exists (design: fm CLI facts).
            if (model !== undefined && model !== 'system') {
                throw new DecisionRequestError(
                    `fm-local supports only the 'system' model (or undefined); got '${model}'`,
                    undefined,
                    undefined,
                );
            }
            const entries = Object.entries(questions);
            if (entries.length === 0) {
                throw new DecisionRequestError('expected a nonempty question map', undefined, undefined);
            }
            for (const [key, question] of entries) {
                const optionCount =
                    question.kind === 'choice'
                        ? Object.keys(question.labels).length
                        : question.kind === 'score'
                          ? question.rubric.length
                          : 2; // noul is binary by type
                if (optionCount < 2) {
                    throw new DecisionRequestError(
                        `question '${key}' has fewer than two options (${optionCount})`,
                        undefined,
                        undefined,
                    );
                }
            }

            // R8: prerequisite probe before the first sample; cached per driver.
            await ensureFmAvailable();

            const instructions = FM_INSTRUCTIONS;
            const prompt = buildPrompt(state, questions);

            // R4: pre-flight budget — over budget rejects before any `fm respond`.
            const tokens = await countPromptTokens(executor, fmPath, instructions, prompt);
            if (tokens > maxPromptTokens) {
                throw new DecisionRequestError(
                    `prompt is ${tokens} tokens, above the maxPromptTokens budget of ${maxPromptTokens}`,
                    undefined,
                    undefined,
                );
            }

            // R3: one schema per ask over the whole question map, in a uniquely
            // named temp file, deleted in `finally` on success and failure.
            const schemaPath = joinPath(getProcessEnv().TMPDIR ?? '/tmp', `fm-schema-${crypto.randomUUID()}.json`);
            try {
                fs.writeFile(schemaPath, JSON.stringify(buildFmSchema(questions)));

                // R5: k sequential samples; each stdout parsed as JSON, read by key.
                const allowed = new Map(entries.map(([key, question]) => [key, declaredOptions(question)]));
                const samplesByKey = new Map(entries.map(([key]) => [key, [] as string[]]));
                for (let i = 0; i < k; i++) {
                    const stdout = await runFmRespond(
                        executor,
                        fmPath,
                        respondArgv({ schemaPath, instructions, prompt, greedy: deterministic, guardrails }),
                        requestTimeoutMs,
                    );
                    const parsed = parseFmRespond(stdout);
                    for (const [key, values] of samplesByKey) {
                        values.push(requireEnumValue(parsed, key, allowed.get(key) ?? []));
                    }
                }

                // R6: frequencies over the declared labels/levels, argmax with
                // declaration-order / lower-level tie-break, entropy confidence.
                const answers: Record<string, Answer> = {};
                for (const [key, question] of entries) {
                    const values = samplesByKey.get(key) ?? [];
                    switch (question.kind) {
                        case 'choice':
                            answers[key] = estimateChoice(Object.keys(question.labels), values);
                            break;
                        case 'score':
                            answers[key] = estimateScore(question.rubric, values);
                            break;
                        case 'noul':
                            answers[key] = estimateNoul(values);
                            break;
                    }
                }
                return answers;
            } finally {
                fs.deleteFile(schemaPath);
            }
        },
    };
}
