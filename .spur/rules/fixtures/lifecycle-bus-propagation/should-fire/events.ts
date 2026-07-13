// Fixture-local event map. Index signature satisfies the EventMap constraint
// used by the inline EventBus stub below. Shared across the should-fire
// fixtures so they stay self-contained (no resolution against the real
// @gobing-ai/ts-infra package — the rule text-matches `events?: EventBus<`).
export interface DemoEvents {
    [event: string]: (...args: never[]) => void;
    'demo.started': (payload: { id: string }) => void;
    'demo.stopped': (payload: { id: string }) => void;
}
