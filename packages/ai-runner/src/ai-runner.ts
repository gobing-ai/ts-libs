import { type BusLifecycleEvents, EventBus, getLogger, type Logger, traceAsync } from '@gobing-ai/ts-infra';
import {
    getProcessCwd,
    nodeBunFactory,
    type ProcessExecutor,
    type ProcessOutputChunk,
    type ProcessResult,
    type TracerPort,
} from '@gobing-ai/ts-runtime';
import { type AgentName, getAgentShim, type PromptOptions, type ShimCommand } from './agents/shims';
import type { AgentEvents, AiRunnerProcessEvents } from './events';
import { buildIdentityPreamble } from './identity';
import { translateSlashCommand } from './slash-command';

/** Result returned by every AI runner dispatch method. */
export interface AgentRunResult {
    /** Process exit code; null indicates signal or timeout termination. */
    exitCode: number | null;
    /** Captured stdout. */
    stdout: string;
    /** Captured stderr. */
    stderr: string;
    /** Signal description when the process was terminated by signal. */
    signal?: string;
    /** Wall-clock duration in milliseconds. */
    durationMs: number;
}

/** Per-invocation runtime options. */
export interface AgentRunOptions {
    /** Working directory for the invocation. */
    cwd?: string;
    /** Timeout in milliseconds. */
    timeout?: number;
    /** AbortSignal forwarded to ProcessExecutor — aborts the agent subprocess when fired. */
    signal?: AbortSignal;
    /** Incremental output observer; the final buffered result is still returned. */
    onOutput?: (output: ProcessOutputChunk) => void;
    /** Optional application-owned correlation propagated unchanged to agent lifecycle events. */
    correlation?: AgentRunCorrelation;
}

/** Application-owned execution identity carried without coupling the runner to a workflow model. */
export interface AgentRunCorrelation {
    readonly runId: string;
    readonly executionId: string;
    readonly actionId?: string;
}

/** Constructor options for AiRunner. */
export interface AiRunnerOptions {
    /** Process executor used for all subprocess invocations. */
    processExecutor?: ProcessExecutor;
    /** Default working directory for invocations. */
    defaultCwd?: string;
    /** Default timeout in milliseconds. */
    defaultTimeout?: number;
    /** Logger for invocation diagnostics. Defaults to `getLogger('ai-runner')`. */
    logger?: Logger;
    /** Event bus receiving process-level observability from the default executor. */
    processEvents?: EventBus<AiRunnerProcessEvents>;
    /** Event bus receiving agent-level invocation observability. */
    events?: EventBus<AgentEvents>;
    /**
     * Optional lifecycle bus to bridge `agent.*` and `process.*` events into
     * the application System Events stream (R4). When `events` / `processEvents`
     * are omitted the runner constructs internal buses parented to this bus.
     */
    lifecycleBus?: EventBus<BusLifecycleEvents>;
    /** Tracer adapter for the default executor. Defaults to `ts-infra` traceAsync. */
    tracer?: TracerPort;
}

/** Dispatches coding-agent CLI commands through pure command shims. */
export class AiRunner {
    private readonly processExecutor: ProcessExecutor;
    private readonly defaultCwd: string | undefined;
    private readonly defaultTimeout: number | undefined;
    private readonly logger: Logger;
    private readonly events: EventBus<AgentEvents> | undefined;
    /** Internal process-level observability bus, parented to `lifecycleBus` when auto-constructed. Exposed for introspection/testing. */
    readonly processEvents: EventBus<AiRunnerProcessEvents> | undefined;

    constructor(options: AiRunnerOptions = {}) {
        const processEvents =
            options.processEvents ??
            (options.lifecycleBus
                ? new EventBus<AiRunnerProcessEvents>({ lifecycleBus: options.lifecycleBus })
                : undefined);
        const events =
            options.events ??
            (options.lifecycleBus ? new EventBus<AgentEvents>({ lifecycleBus: options.lifecycleBus }) : undefined);
        this.processExecutor =
            options.processExecutor ??
            nodeBunFactory.createProcessExecutor({
                ...(processEvents !== undefined
                    ? {
                          events: {
                              emit: (event, detail) => {
                                  void processEvents?.emit(event, detail);
                              },
                          },
                      }
                    : {}),
                tracer: options.tracer ?? {
                    traceAsync: async (name, fn) => await traceAsync(name, (span) => fn(span)),
                },
            });
        this.defaultCwd = options.defaultCwd;
        this.defaultTimeout = options.defaultTimeout;
        this.logger = options.logger ?? getLogger('ai-runner');
        this.events = events;
        this.processEvents = processEvents;
    }

    /** Run an agent help command. */
    runHelpCommand(agent: AgentName, options: AgentRunOptions = {}): Promise<AgentRunResult> {
        return this.invoke(agent, 'help', getAgentShim(agent).getHelpCommand(), options, true);
    }

    /** Run an agent version command. */
    runVersionCommand(agent: AgentName, options: AgentRunOptions = {}): Promise<AgentRunResult> {
        return this.invoke(agent, 'version', getAgentShim(agent).getVersionCommand(), options, true);
    }

    /** Run an agent prompt command. */
    runPromptCommand(
        agent: AgentName,
        promptOptions: PromptOptions,
        options: AgentRunOptions = {},
    ): Promise<AgentRunResult> {
        return this.invoke(agent, 'prompt', this.buildPromptCommand(agent, promptOptions, options), options, false);
    }

    /** Translate a Claude-style slash command and run it as a prompt command. */
    runSlashCommand(
        agent: AgentName,
        input: string,
        promptOptions: PromptOptions,
        options: AgentRunOptions = {},
    ): Promise<AgentRunResult> {
        return this.runPromptCommand(agent, { ...promptOptions, input: translateSlashCommand(agent, input) }, options);
    }

    /** Build an agent prompt command without executing it. */
    buildPromptCommand(agent: AgentName, promptOptions: PromptOptions, options: AgentRunOptions = {}): ShimCommand {
        return buildAgentCommand(agent, promptOptions, {
            workspace: options.cwd ?? this.defaultCwd ?? getProcessCwd(),
        });
    }

    /** Run an agent authentication command, or return null when unsupported. */
    runAuthCommand(agent: AgentName, options: AgentRunOptions = {}): Promise<AgentRunResult> | null {
        const command = getAgentShim(agent).getAuthCommand();
        return command === null ? null : this.invoke(agent, 'auth', command, options, true);
    }

    private async invoke(
        agent: AgentName,
        operation: string,
        command: { command: string; args: string[] },
        options: AgentRunOptions,
        forceBuffered: boolean,
    ): Promise<AgentRunResult> {
        const label = `ai-runner.${agent}.${operation}`;
        this.logger.debug('invoke', { label, command: command.command, args: command.args.join(' ') });
        void this.events?.emit('agent.invoke.start', {
            agent,
            operation,
            label,
            ...(options.correlation !== undefined ? { correlation: options.correlation } : {}),
        });
        const result: ProcessResult = await this.processExecutor.run({
            command: command.command,
            args: command.args,
            label,
            rejectOnError: false,
            forceBuffered,
            cwd: options.cwd ?? this.defaultCwd,
            timeout: options.timeout ?? this.defaultTimeout,
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            ...(options.onOutput !== undefined ? { onOutput: options.onOutput } : {}),
        });
        if (result.exitCode !== 0) {
            this.logger.error('invoke exited non-zero', {
                label,
                exitCode: result.exitCode,
                signal: result.signal,
            });
        }
        void this.events?.emit('agent.invoke.exit', {
            agent,
            operation,
            label,
            exitCode: result.exitCode,
            ...(result.signal !== undefined ? { signal: result.signal } : {}),
            durationMs: result.durationMs,
            ...(options.correlation !== undefined ? { correlation: options.correlation } : {}),
        });
        return {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            ...(result.signal !== undefined ? { signal: result.signal } : {}),
            durationMs: result.durationMs,
        };
    }
}

function hasIdentityOptions(options: PromptOptions): boolean {
    return (
        options.purpose !== undefined ||
        options.systemPrompt !== undefined ||
        options.taskId !== undefined ||
        (options.peers !== undefined && options.peers.length > 0)
    );
}

/**
 * Shared command-build seam: identity preamble + shim dispatch. Both the
 * one-shot path (`AiRunner.buildPromptCommand`) and the team-mode path
 * (`TeamOrchestrator.startAgent`) resolve argv through this single function
 * so equivalent `PromptOptions` produce equivalent argv (R5 parity).
 */
export function buildAgentCommand(
    agent: AgentName,
    promptOptions: PromptOptions,
    context: { workspace: string },
): ShimCommand {
    return getAgentShim(agent).getPromptCommand(applyIdentityPreamble(agent, promptOptions, context));
}

function applyIdentityPreamble(
    agent: AgentName,
    promptOptions: PromptOptions,
    context: { workspace: string },
): PromptOptions {
    if (!hasIdentityOptions(promptOptions)) return promptOptions;
    const preamble = buildIdentityPreamble({
        agentId: agent,
        agentType: agent,
        workspace: context.workspace,
        purpose: promptOptions.purpose,
        systemPrompt: promptOptions.systemPrompt,
        taskId: promptOptions.taskId,
        peers: promptOptions.peers,
    });
    const input = promptOptions.input === undefined ? preamble : `${preamble}\n${promptOptions.input}`;
    return { ...promptOptions, input };
}
