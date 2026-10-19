/**
 * The Apple `fm` decision driver (task 0084 R2, R8, R9; task 0114 R7). Satisfies
 * the same {@link DecisionDriver} contract as the other backends over one-shot
 * `fm` processes, built on the shared sampled-driver core: one schema per ask
 * answers the whole question map, probabilities come from k sample frequencies
 * (ADR-030), and every failure surfaces through the decision error taxonomy —
 * never as an answer.
 */

import {
    type Answer,
    buildEnumSchema,
    createSampledDriver,
    DECISION_INSTRUCTIONS,
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
import {
    countPromptTokens,
    type FmGuardrails,
    parseFmRespond,
    probeFmAvailability,
    respondArgv,
    runFmRespond,
} from './fm-process';

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

    // Order kept from the pre-refactor driver: the samples error precedes PLATFORM.
    if (!Number.isInteger(samples) || samples < 1) {
        throw new DecisionRequestError(`samples must be a positive integer; got ${samples}`, undefined, undefined);
    }

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
        await probeFmAvailability(executor, fmPath, requestTimeoutMs);
        availabilityVerified = true;
    }

    const inner = createSampledDriver({
        name: 'fm-local',
        sampleLabel: 'fm',
        samples,
        deterministic,
        instructions: DECISION_INSTRUCTIONS,
        async open({ instructions, prompt, questions }) {
            // R8: prerequisite probe before the first sample; cached per driver.
            await ensureFmAvailable();

            // R4: pre-flight budget — over budget rejects before any `fm respond`.
            const tokens = await countPromptTokens(executor, fmPath, instructions, prompt, requestTimeoutMs);
            if (tokens > maxPromptTokens) {
                throw new DecisionRequestError(
                    `prompt is ${tokens} tokens, above the maxPromptTokens budget of ${maxPromptTokens}`,
                    undefined,
                    undefined,
                );
            }

            // R3: one schema per ask over the whole question map, in a uniquely
            // named temp file, deleted by `close` on success and failure.
            const schemaPath = joinPath(getProcessEnv().TMPDIR ?? '/tmp', `fm-schema-${crypto.randomUUID()}.json`);
            const session = {
                async sample(): Promise<Record<string, string>> {
                    const stdout = await runFmRespond(
                        executor,
                        fmPath,
                        respondArgv({ schemaPath, instructions, prompt, greedy: deterministic, guardrails }),
                        requestTimeoutMs,
                    );
                    return parseFmRespond(stdout);
                },
                close(): void {
                    fs.deleteFile(schemaPath);
                },
            };
            try {
                fs.writeFile(schemaPath, JSON.stringify(buildEnumSchema(questions)));
            } catch (error) {
                // Mirrors the pre-refactor `finally`: a failed write still deletes.
                fs.deleteFile(schemaPath);
                throw error;
            }
            return session;
        },
    });

    return {
        name: 'fm-local',
        estimator: inner.estimator,

        // R9: only the on-device system model exists (design: fm CLI facts). The
        // guard runs before the core so the model error keeps today's precedence.
        async ask({
            state,
            questions,
            model,
        }: {
            state: DecisionState;
            questions: Record<string, Question>;
            model?: string;
        }): Promise<Record<string, Answer>> {
            if (model !== undefined && model !== 'system') {
                throw new DecisionRequestError(
                    `fm-local supports only the 'system' model (or undefined); got '${model}'`,
                    undefined,
                    undefined,
                );
            }
            return inner.ask({ state, questions, model });
        },
    };
}
