/**
 * The `llm-agent` decision driver (task 0115, ADR-038/ADR-039): any installed
 * `ts-ai-runner` coding agent or model answering through the shared sampled-driver
 * core. Each sample is one isolated one-shot prompt run; probabilities are sample
 * frequencies (ADR-030) — the agent is never asked for a confidence.
 *
 * Every sample runs in a per-ask scratch directory. That is load-bearing, not
 * tidiness: the claude one-shot shim grants `--permission-mode acceptEdits
 * --allowedTools Write Edit`, so a decision must never be able to write into the
 * caller's workspace (R6).
 */

import {
    AgentDetector,
    type AgentName,
    AiRunner,
    createSampledDriver,
    DecisionBackendError,
    DecisionConfigError,
    DecisionTimeoutError,
    declaredOptions,
    extractJsonAnswer,
    type PromptOptions,
    type Question,
    type SampledDecisionDriver,
    type SampleSession,
    TIER1_PRIORITY,
} from '@gobing-ai/ts-ai-runner';
import { createNodeFileSystem, type FileSystem, getProcessEnv, joinPath } from '@gobing-ai/ts-runtime';

/** The one runner method a sampled decision needs; a real `AiRunner` satisfies it. */
export type AgentPromptRunner = Pick<AiRunner, 'runPromptCommand'>;

/** The one detector method the driver needs; a real `AgentDetector` satisfies it. */
export type AgentDetectorPort = Pick<AgentDetector, 'detectOne'>;

/** Configuration options for {@link createAgentDriver}. */
export interface AgentDriverOptions {
    /** Agent to sample. Default: the first installed agent in `TIER1_PRIORITY` (fm is never auto-picked). */
    readonly agent?: AgentName;
    /** Model id forwarded as `PromptOptions.model`; a per-ask `model` overrides it. */
    readonly model?: string;
    /** Samples per ask. Default: 3. Ignored when `deterministic`. */
    readonly samples?: number;
    /** One greedy sample; probabilities are one-hot. Default: false. */
    readonly deterministic?: boolean;
    /** Max samples in flight. Default: 1 (sequential). */
    readonly concurrency?: number;
    /** Budget for one sample. Default: 120_000. */
    readonly timeoutMs?: number;
    /** Injected runner. Default: a lazy `new AiRunner()`. */
    readonly runner?: AgentPromptRunner;
    /** Injected detector. Default: a lazy `new AgentDetector({ runner })`. */
    readonly detector?: AgentDetectorPort;
    /** Scratch-directory lifecycle. Default: ts-runtime's node FileSystem. */
    readonly fs?: Pick<FileSystem, 'ensureDir' | 'deleteFile'>;
}

/** The agent driver: a sampled decision driver named `llm-agent`. */
export interface AgentDecisionDriver extends SampledDecisionDriver {
    readonly name: 'llm-agent';
}

/**
 * Instructions for a *generic* agent. fm's text mentions "the schema" because fm
 * receives `--schema`; agents get no such flag, so this text never does.
 */
export const AGENT_INSTRUCTIONS =
    'You are a decision function. Read the context and questions, then reply with exactly one JSON ' +
    'object mapping each question key to one of its allowed option strings. No prose, no code, no ' +
    'tool use, no confidence values.';

/**
 * The per-ask reply contract appended to the prompt: every key with its allowed
 * option strings, plus one example object. It never asks for probabilities or
 * confidence (ADR-030).
 */
export function JSON_REPLY_SUFFIX(questions: Record<string, Question>): string {
    const lines = ['', 'Reply with exactly one JSON object and nothing else.'];
    for (const [key, question] of Object.entries(questions)) {
        const options = declaredOptions(question)
            .map((option) => `"${option}"`)
            .join(', ');
        lines.push(`- "${key}": one of ${options}`);
    }
    const example: Record<string, string> = {};
    for (const [key, question] of Object.entries(questions)) {
        example[key] = declaredOptions(question)[0] ?? '';
    }
    lines.push('', 'Example:', JSON.stringify(example));
    return lines.join('\n');
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Build the `llm-agent` decision driver. Construction spawns nothing: the runner
 * and detector are created lazily and the agent is resolved on the first `ask`.
 */
export function createAgentDriver(options: AgentDriverOptions = {}): AgentDecisionDriver {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fs = options.fs ?? createNodeFileSystem();
    // Created inside the factory, and only when not injected, so construction never spawns.
    const runner = options.runner ?? new AiRunner();
    // A real AiRunner satisfies AgentPromptRunner, so this cast only widens a fake back
    // to the injected seam; a fake runner is always paired with its own fake detector.
    const detector = options.detector ?? new AgentDetector({ runner: runner as AiRunner });
    // Memoised on success only: a later ask retries an unresolved agent after an install.
    let resolved: AgentName | undefined;

    async function resolveAgent(): Promise<AgentName> {
        if (options.agent !== undefined) return options.agent;
        if (resolved !== undefined) return resolved;
        for (const candidate of TIER1_PRIORITY) {
            const detected = await detector.detectOne(candidate);
            if (detected.installed) {
                resolved = detected.name as AgentName;
                return resolved;
            }
        }
        throw new DecisionConfigError(
            `no coding agent available for llm-agent; install one of: ${TIER1_PRIORITY.join(', ')}`,
            'AGENT',
        );
    }

    return createSampledDriver({
        name: 'llm-agent',
        samples: options.samples ?? 3,
        deterministic: options.deterministic ?? false,
        concurrency: options.concurrency ?? 1,
        instructions: AGENT_INSTRUCTIONS,
        async open({ instructions, prompt, questions, model }): Promise<SampleSession> {
            const agent = await resolveAgent();
            const scratch = joinPath(getProcessEnv().TMPDIR ?? '/tmp', `llm-agent-${crypto.randomUUID()}`);
            await fs.ensureDir(scratch);
            const input = `${instructions}\n\n${prompt}${JSON_REPLY_SUFFIX(questions)}`;
            const promptOptions: PromptOptions = { input, mode: 'text' };
            const effectiveModel = model ?? options.model;
            if (effectiveModel !== undefined) promptOptions.model = effectiveModel;

            return {
                async sample(): Promise<Record<string, string>> {
                    const result = await runner.runPromptCommand(agent, promptOptions, {
                        cwd: scratch,
                        timeout: timeoutMs,
                    });
                    if (result.exitCode === null) {
                        throw new DecisionTimeoutError(`llm-agent sample timed out after ${timeoutMs}ms`, timeoutMs);
                    }
                    if (result.exitCode !== 0) {
                        const firstLine = result.stderr.split('\n')[0]?.trim() ?? '';
                        throw new DecisionBackendError(
                            `llm-agent sample failed (${agent} exit ${result.exitCode}): ${firstLine}`,
                            undefined,
                        );
                    }
                    return extractJsonAnswer(result.stdout);
                },
                close: () => fs.deleteFile(scratch),
            };
        },
    }) as AgentDecisionDriver;
}
