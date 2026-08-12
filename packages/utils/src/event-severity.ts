/** Observability severity stamped by the event producer at emit time. */
export type EventSeverity = 'info' | 'warning' | 'error';

/** Mixin for lifecycle event details that carry producer-owned severity. */
export interface WithEventSeverity {
    severity: EventSeverity;
}
