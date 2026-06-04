import type { InboxMessage, InboxMessageDao } from '@gobing-ai/ts-db/inbox';

/** Thin wrapper around `InboxMessageDao` that provides enqueue/drain/deliver/fail/inbox semantics for agent-to-agent messaging. */
export class MessageService {
    constructor(private readonly dao: InboxMessageDao) {}

    enqueue(fromId: string | null, toId: string, body: string, inReplyTo?: string): Promise<string> {
        return this.dao.enqueue(fromId, toId, body, inReplyTo);
    }

    drain(toId: string): Promise<InboxMessage[]> {
        return this.dao.drainPending(toId);
    }

    deliver(msgId: string): Promise<void> {
        return this.dao.markDelivered(msgId);
    }

    fail(msgId: string, error: string): Promise<void> {
        return this.dao.markFailed(msgId, error);
    }

    inbox(toId: string, limit?: number, offset?: number): Promise<InboxMessage[]> {
        return this.dao.inbox(toId, limit, offset);
    }

    countPending(toId: string): Promise<number> {
        return this.dao.countPending(toId);
    }

    static formatMessage(msg: InboxMessage): string {
        return `[task from=${msg.fromId ?? 'operator'} id=${msg.id}] ${msg.body}`;
    }
}
