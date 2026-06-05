import { getLogger, type Logger } from '@gobing-ai/ts-infra';
import { getProcessCwd, NodeProcessExecutor, type ProcessExecutor, type ProcessResult } from '@gobing-ai/ts-runtime';
import { type AgentName, getAgentShim, type PromptOptions, type ShimCommand } from './agents/shims';
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
}

/** Dispatches coding-agent CLI commands through pure command shims. */
export class AiRunner {
    private readonly processExecutor: ProcessExecutor;
    private readonly defaultCwd: string | undefined;
    private readonly defaultTimeout: number | undefined;
    private readonly logger: Logger;

    constructor(options: AiRunnerOptions = {}) {
        this.processExecutor = options.processExecutor ?? new NodeProcessExecutor();
        this.defaultCwd = options.defaultCwd;
        this.defaultTimeout = options.defaultTimeout;
        this.logger = options.logger ?? getLogger('ai-runner');
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
        return getAgentShim(agent).getPromptCommand(this.withIdentityPreamble(agent, promptOptions, options));
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
        const result: ProcessResult = await this.processExecutor.run({
            command: command.command,
            args: command.args,
            label,
            rejectOnError: false,
            forceBuffered,
            cwd: options.cwd ?? this.defaultCwd,
            timeout: options.timeout ?? this.defaultTimeout,
        });
        if (result.exitCode !== 0) {
            this.logger.error('invoke exited non-zero', {
                label,
                exitCode: result.exitCode,
                signal: result.signal,
            });
        }
        return {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            ...(result.signal !== undefined ? { signal: result.signal } : {}),
            durationMs: result.durationMs,
        };
    }

    private withIdentityPreamble(
        agent: AgentName,
        promptOptions: PromptOptions,
        options: AgentRunOptions,
    ): PromptOptions {
        if (!hasIdentityOptions(promptOptions)) return promptOptions;
        const workspace = options.cwd ?? this.defaultCwd ?? getProcessCwd();
        const preamble = buildIdentityPreamble({
            agentId: agent,
            agentType: agent,
            workspace,
            purpose: promptOptions.purpose,
            systemPrompt: promptOptions.systemPrompt,
            taskId: promptOptions.taskId,
            peers: promptOptions.peers,
        });
        const input = promptOptions.input === undefined ? preamble : `${preamble}\n${promptOptions.input}`;
        return { ...promptOptions, input };
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
