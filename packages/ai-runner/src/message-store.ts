/**
 * ai-runner-owned orchestration persistence boundary (ADR-023 follow-up A4).
 *
 * `TeamOrchestrator` depends only on this port. `InboxMessageDao` from
 * `@gobing-ai/ts-db/inbox` satisfies it structurally — no adapter class — and
 * in-memory test doubles implement it directly.
 */

/**
 * Minimal read-only view of a drained message containing only the fields
 * `ts-ai-runner` consumes. It deliberately does not mirror the full
 * `InboxMessage` persistence model.
 */
export interface DrainedMessage {
    readonly id: string;
    readonly fromId: string | null;
    readonly body: string;
}

/**
 * Message store operations consumed by `TeamOrchestrator`. Mirrors the subset
 * of `InboxMessageDao` operations the orchestrator uses: enqueue a message,
 * drain pending messages for a recipient, mark a message delivered, and mark
 * a message failed.
 */
export interface MessageStore {
    enqueue(fromId: string | null, toId: string, body: string, inReplyTo?: string): Promise<string>;
    drainPending(toId: string): Promise<DrainedMessage[]>;
    markDelivered(msgId: string): Promise<void>;
    markFailed(msgId: string, error: string): Promise<void>;
}
