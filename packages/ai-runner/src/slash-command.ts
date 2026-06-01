import type { AgentName } from './agents/shims';

/**
 * Matches a Claude-style slash command: `/plugin:command [args]`.
 *
 * Captures the plugin namespace, the command, and any trailing argument text.
 */
const SLASH_COMMAND_RE = /^\/([a-zA-Z0-9._-]+):([a-zA-Z0-9._-]+)(\s.*)?$/;

/** Whether the input is a Claude-style `/plugin:command` slash command. */
export function isClaudeStyleSlashCommand(input: string): boolean {
    return SLASH_COMMAND_RE.test(input);
}

/**
 * Translate a Claude-style `/plugin:command args` into the target agent's
 * slash-command dialect. Non-slash-command input is returned unchanged.
 *
 * | Agent      | `/plugin:command args` becomes        |
 * |------------|---------------------------------------|
 * | claude     | `/plugin:command args` (pass-through) |
 * | codex      | `$plugin-command args`                |
 * | pi         | `/skill:plugin-command args`          |
 * | all others | `/plugin-command args`                |
 */
export function translateSlashCommand(agent: AgentName, input: string): string {
    const match = SLASH_COMMAND_RE.exec(input);
    if (!match) return input;
    const [, plugin, command, rest = ''] = match;
    const args = rest.trimStart();
    const suffix = args.length > 0 ? ` ${args}` : '';
    switch (agent) {
        case 'claude':
            return `/${plugin}:${command}${suffix}`;
        case 'codex':
            return `$${plugin}-${command}${suffix}`;
        case 'pi':
            return `/skill:${plugin}-${command}${suffix}`;
        default:
            return `/${plugin}-${command}${suffix}`;
    }
}
