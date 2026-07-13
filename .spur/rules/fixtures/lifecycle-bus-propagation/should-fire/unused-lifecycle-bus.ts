// should-fire fixture — superficially declares lifecycleBus but never uses it
// to parent the internal EventBus. An identifier-only matcher incorrectly
// accepts this shape; the rule must require an actual parented construction.
type EventMap = Record<string, (...args: never[]) => void>;
type BusLifecycleEvents = { [event: string]: (...args: never[]) => void };
class EventBus<T extends EventMap> {
    readonly _t?: T;
    constructor(_opts?: { lifecycleBus?: EventBus<BusLifecycleEvents> }) {}
}

import type { DemoEvents } from './events';

export interface UnusedLifecycleOptions {
    events?: EventBus<DemoEvents>;
    lifecycleBus?: EventBus<BusLifecycleEvents>;
}

export class UnusedLifecycleService {
    private readonly events: EventBus<DemoEvents>;

    constructor(opts: UnusedLifecycleOptions = {}) {
        // Suggested but deliberately not implemented:
        // new EventBus<DemoEvents>({ lifecycleBus: opts.lifecycleBus });
        this.events = opts.events ?? new EventBus<DemoEvents>();
        void opts.lifecycleBus;
    }
}
