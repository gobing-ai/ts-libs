import { BunSyncProcessExecutor, type SyncProcessExecutor } from '@gobing-ai/ts-runtime';

/** Context used to construct the identity preamble injected into agent prompts. */
export interface IdentityContext {
    agentId: string;
    agentType: string;
    workspace: string;
    purpose?: string;
    taskId?: string;
    taskTitle?: string;
    systemPrompt?: string;
    peers?: Array<{ id: string; type: string; purpose?: string }>;
    gitBranch?: string;
    gitDirty?: boolean;
    guardrails?: string[];
}

/** Build a human-readable identity preamble string that describes the agent, its task, peers, guardrails, and git context. */
export function buildIdentityPreamble(ctx: IdentityContext): string {
    const sections: string[] = [
        `You are agent \`${ctx.agentId}\` (${ctx.agentType}) in workspace \`${ctx.workspace}\`.`,
    ];

    if (ctx.taskId !== undefined) {
        const title = ctx.taskTitle === undefined ? '' : ` — ${ctx.taskTitle}`;
        sections.push(`Your current task: #${ctx.taskId}${title}.`);
    }

    if (ctx.purpose !== undefined && ctx.purpose.trim() !== '') sections.push(`Your purpose: ${ctx.purpose}.`);
    if (ctx.systemPrompt !== undefined && ctx.systemPrompt.trim() !== '') sections.push(ctx.systemPrompt);

    if ((ctx.peers?.length ?? 0) > 0) {
        sections.push(
            [
                'Peer agents in this workspace:',
                ...(ctx.peers ?? []).map(
                    (peer) => `- \`${peer.id}\` (${peer.type}) — ${peer.purpose ?? '(no purpose set)'}`,
                ),
            ].join('\n'),
        );
    }

    sections.push(
        [
            'Communication:',
            '- Send a message with: spur message send --to <agent-id> "<message>"',
            '- Reply to a message with: spur message reply <msg-id> "<response>"',
            '- Read pending messages with: spur message inbox',
        ].join('\n'),
    );

    if (ctx.gitBranch !== undefined) {
        sections.push(
            ['Git context:', `branch: ${ctx.gitBranch}`, `dirty: ${ctx.gitDirty === true ? 'true' : 'false'}`].join(
                '\n',
            ),
        );
    }

    if ((ctx.guardrails?.length ?? 0) > 0) {
        sections.push(['Guardrails:', ...(ctx.guardrails ?? []).map((guardrail) => `- ${guardrail}`)].join('\n'));
    }

    return `${sections.join('\n\n')}\n`;
}

/** Query git for the current branch name and dirty file count in `workspacePath`. Returns a pre-formatted "Git context" block, or `null` if git is unavailable or the directory is not a repo. */
export function getGitContext(
    workspacePath: string,
    executor: SyncProcessExecutor = new BunSyncProcessExecutor(),
): string | null {
    const branch = runGit(executor, ['-C', workspacePath, 'branch', '--show-current']);
    if (branch === null || branch === '') return null;

    const status = runGit(executor, ['-C', workspacePath, 'status', '--porcelain']);
    const dirtyCount = status === null || status === '' ? 0 : status.split('\n').filter(Boolean).length;
    return ['Git context:', `branch: ${branch}`, `dirty: ${dirtyCount === 0 ? 'false' : `${dirtyCount} files`}`].join(
        '\n',
    );
}

function runGit(executor: SyncProcessExecutor, args: string[]): string | null {
    const result = executor.runSync({ command: 'git', args, rejectOnError: false, forceBuffered: true });
    if (result.exitCode !== 0) return null;
    return result.stdout.trim();
}
