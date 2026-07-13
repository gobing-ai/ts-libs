import { sql } from 'drizzle-orm';
import type { DbAdapter } from './adapter';
import type { UpdateReturningDb } from './drizzle-builders';
import { EntityDao } from './entity-dao';
import { inboxMessages } from './schema/inbox-messages';

/** Row type inferred from the inbox_messages Drizzle schema. */
export type InboxMessage = typeof inboxMessages.$inferSelect;

// ---------------------------------------------------------------------------
// Event types (structural port — no ts-infra dependency, per ADR-013 pattern)
// ---------------------------------------------------------------------------

/** Payload for a `message.enqueued` event. */
export interface EnqueuedMessageDetail {
    id: string;
    fromId: string | null;
    toId: string;
    inReplyTo?: string;
    timestamp: number;
}

/** Payload for a `message.injected` event (one per row returned by `drainPending`). */
export interface InjectedMessageDetail {
    id: string;
    fromId: string | null;
    toId: string;
    inReplyTo?: string | null;
    injectAttempts: number;
    timestamp: number;
}

/** Payload for a `message.delivered` event. */
export interface DeliveredMessageDetail {
    id: string;
    fromId: string | null;
    toId: string;
    deliveredAt: number;
    timestamp: number;
}

/** Payload for a `message.failed` event. */
export interface FailedMessageDetail {
    id: string;
    fromId: string | null;
    toId: string;
    error: string;
    timestamp: number;
}

/** Typed event map for inbox message lifecycle transitions. */
export type InboxMessageEvents = {
    'message.enqueued': (detail: EnqueuedMessageDetail) => void;
    'message.injected': (detail: InjectedMessageDetail) => void;
    'message.delivered': (detail: DeliveredMessageDetail) => void;
    'message.failed': (detail: FailedMessageDetail) => void;
};

/**
 * Zero-dependency structural event sink.
 * `EventBus<InboxMessageEvents>` is structurally compatible — pass it as
 * `{ events: eventBus }` in `InboxMessageDaoOptions`.
 */
export interface InboxMessageEventSink {
    emit<K extends keyof InboxMessageEvents>(event: K, ...args: Parameters<InboxMessageEvents[K]>): void;
}

/** Options bag for `InboxMessageDao`. */
export interface InboxMessageDaoOptions {
    /** Optional structural event sink for message lifecycle observability. */
    events?: InboxMessageEventSink;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return (
        value !== null &&
        (typeof value === 'object' || typeof value === 'function') &&
        typeof (value as { then?: unknown }).then === 'function'
    );
}

// ---------------------------------------------------------------------------
// DAO
// ---------------------------------------------------------------------------

/**
 * DAO for durable inter-agent inbox messages.
 */
export class InboxMessageDao extends EntityDao<typeof inboxMessages, typeof inboxMessages.id> {
    private readonly events?: InboxMessageEventSink;

    constructor(adapter: DbAdapter, options: InboxMessageDaoOptions = {}) {
        super(adapter, inboxMessages, [inboxMessages.id], 'inbox_messages');
        this.events = options.events;
    }

    async enqueue(fromId: string | null, toId: string, body: string, inReplyTo?: string): Promise<string> {
        const id = crypto.randomUUID();
        const now = this.now();
        await this.create({
            id,
            fromId,
            toId,
            body,
            status: 'queued',
            injectAttempts: 0,
            createdAt: now,
            updatedAt: now,
            ...(inReplyTo !== undefined ? { inReplyTo } : {}),
        });
        this.emitEvent('message.enqueued', {
            id,
            fromId,
            toId,
            ...(inReplyTo !== undefined ? { inReplyTo } : {}),
            timestamp: now,
        });
        return id;
    }

    async drainPending(toId: string): Promise<InboxMessage[]> {
        const now = this.now();
        const rows = (await (this.db as UpdateReturningDb)
            .update(inboxMessages)
            .set({
                status: 'injected',
                injectAttempts: sql`${inboxMessages.injectAttempts} + 1`,
                updatedAt: now,
            })
            .where(
                sql`${inboxMessages.id} IN (
                    SELECT id
                    FROM ${inboxMessages}
                    WHERE to_id = ${toId}
                      AND status = 'queued'
                    ORDER BY created_at
                )
                AND ${inboxMessages.status} = 'queued'`,
            )
            .returning()) as InboxMessage[];

        for (const row of rows) {
            this.emitEvent('message.injected', {
                id: row.id,
                fromId: row.fromId,
                toId: row.toId,
                inReplyTo: row.inReplyTo,
                injectAttempts: row.injectAttempts,
                timestamp: now,
            });
        }

        return rows as InboxMessage[];
    }

    async markDelivered(msgId: string): Promise<void> {
        const now = this.now();
        const updated = await this.update(msgId, {
            status: 'delivered',
            deliveredAt: now,
        });
        if (updated) {
            this.emitEvent('message.delivered', {
                id: updated.id,
                fromId: updated.fromId,
                toId: updated.toId,
                deliveredAt: now,
                timestamp: now,
            });
        }
    }

    async markFailed(msgId: string, error: string): Promise<void> {
        const updated = await this.update(msgId, {
            status: 'failed',
            injectError: error,
        });
        if (updated) {
            this.emitEvent('message.failed', {
                id: updated.id,
                fromId: updated.fromId,
                toId: updated.toId,
                error,
                timestamp: updated.updatedAt,
            });
        }
    }

    async inbox(toId: string, limit?: number, offset?: number): Promise<InboxMessage[]> {
        return this.list({
            where: { col: inboxMessages.toId, op: 'eq', value: toId },
            orderBy: [{ col: inboxMessages.createdAt, dir: 'desc' }],
            ...(limit !== undefined ? { limit } : {}),
            ...(offset !== undefined ? { offset } : {}),
        });
    }

    async countPending(toId: string): Promise<number> {
        return this.count({
            and: [
                { col: inboxMessages.toId, op: 'eq', value: toId },
                { col: inboxMessages.status, op: 'eq', value: 'queued' },
            ],
        });
    }

    async getById(id: string): Promise<InboxMessage | undefined> {
        return this.findBy(inboxMessages.id, id);
    }

    /** Event delivery is observational: sink failures never change a committed DAO result. */
    private emitEvent<K extends keyof InboxMessageEvents>(event: K, ...args: Parameters<InboxMessageEvents[K]>): void {
        if (!this.events) return;
        try {
            const pending = this.events.emit(event, ...args) as unknown;
            if (isPromiseLike(pending)) {
                void Promise.resolve(pending).catch(() => {
                    // A rejected observer must not turn a committed mutation into an apparent failure.
                });
            }
        } catch {
            // A throwing observer must not turn a committed mutation into an apparent failure.
        }
    }
}
