// should-pass fixture (shape 1: field-on-options) — compliant: the options
// type declares both events?: EventBus<X> and lifecycleBus?, and the service
// parents its internal EventBus to lifecycleBus. Same file references
// lifecycleBus, so the rule's file-local check passes. Expected: no finding.
//
// Self-contained stubs (the rule text-matches `events?: EventBus<`).
type EventMap = Record<string, (...args: never[]) => void>;
type BusLifecycleEvents = { [event: string]: (...args: never[]) => void };
class EventBus<T extends EventMap> {
    readonly _t?: T;
    constructor(_opts?: { lifecycleBus?: EventBus<BusLifecycleEvents> }) {}
}

import type { DemoEvents } from './events';

export interface DemoOptions {
    events?: EventBus<DemoEvents>;
    lifecycleBus?: EventBus<BusLifecycleEvents>;
}

export class DemoService {
    private readonly events: EventBus<DemoEvents> | undefined;

    constructor(opts: DemoOptions = {}) {
        this.events =
            opts.events ??
            (opts.lifecycleBus ? new EventBus<DemoEvents>({ lifecycleBus: opts.lifecycleBus }) : undefined);
    }

    getEvents(): EventBus<DemoEvents> | undefined {
        return this.events;
    }
}
