import type { DrainedMessage } from './message-store';

/** Renders a drained message into the line injected into an agent's stdin. */
export function formatMessage(msg: DrainedMessage): string {
    return `[task from=${msg.fromId ?? 'operator'} id=${msg.id}] ${msg.body}`;
}
