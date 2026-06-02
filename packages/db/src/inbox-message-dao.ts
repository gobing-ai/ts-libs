import { sql } from 'drizzle-orm';
import type { DbAdapter } from './adapter';
import type { UpdateReturningDb } from './drizzle-builders';
import { EntityDao } from './entity-dao';
import { inboxMessages } from './schema/inbox-messages';

/** Row type inferred from the inbox_messages Drizzle schema. */
export type InboxMessage = typeof inboxMessages.$inferSelect;

/**
 * DAO for durable inter-agent inbox messages.
 */
export class InboxMessageDao extends EntityDao<typeof inboxMessages, typeof inboxMessages.id> {
    constructor(adapter: DbAdapter) {
        super(adapter, inboxMessages, [inboxMessages.id], 'inbox_messages');
    }

    async enqueue(fromId: string | null, toId: string, body: string, inReplyTo?: string): Promise<string> {
        const id = crypto.randomUUID();
        await this.create({
            id,
            fromId,
            toId,
            body,
            status: 'queued',
            injectAttempts: 0,
            ...(inReplyTo !== undefined ? { inReplyTo } : {}),
        });
        return id;
    }

    async drainPending(toId: string): Promise<InboxMessage[]> {
        const now = this.now();
        const rows = await (this.db as UpdateReturningDb)
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
            .returning();

        return rows as InboxMessage[];
    }

    async markDelivered(msgId: string): Promise<void> {
        await this.update(msgId, {
            status: 'delivered',
            deliveredAt: this.now(),
        });
    }

    async markFailed(msgId: string, error: string): Promise<void> {
        await this.update(msgId, {
            status: 'failed',
            injectError: error,
        });
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
}
