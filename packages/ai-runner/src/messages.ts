import type { InboxMessage } from '@gobing-ai/ts-db/inbox';

/** Renders an inbox message into the line injected into an agent's stdin. */
export function formatMessage(msg: InboxMessage): string {
    return `[task from=${msg.fromId ?? 'operator'} id=${msg.id}] ${msg.body}`;
}
