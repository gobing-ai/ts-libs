import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle schema definition for durable inter-agent inbox messages.
 */
export const inboxMessages = sqliteTable(
    'inbox_messages',
    {
        id: text('id').primaryKey(),
        fromId: text('from_id'),
        toId: text('to_id').notNull(),
        body: text('body').notNull(),
        status: text('status').notNull().default('queued'),
        inReplyTo: text('in_reply_to'),
        createdAt: integer('created_at').notNull(),
        updatedAt: integer('updated_at').notNull(),
        deliveredAt: integer('delivered_at'),
        injectAttempts: integer('inject_attempts').notNull().default(0),
        injectError: text('inject_error'),
    },
    (table) => [index('idx_inbox_messages_to_status').on(table.toId, table.status)],
);
