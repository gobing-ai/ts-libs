// should-pass fixture — formatting the constructor options across lines must
// not create a false positive.
type EventMap = Record<string, (...args: never[]) => void>;
type BusLifecycleEvents = { [event: string]: (...args: never[]) => void };
class EventBus<T extends EventMap> {
    readonly _t?: T;
    constructor(_opts?: { lifecycleBus?: EventBus<BusLifecycleEvents> }) {}
}

import type { DemoEvents } from './events';

export interface MultilineOptions {
    events?: EventBus<DemoEvents>;
    lifecycleBus?: EventBus<BusLifecycleEvents>;
}

export function resolveEvents(options: MultilineOptions): EventBus<DemoEvents> | undefined {
    return (
        options.events ??
        new EventBus<DemoEvents>({
            lifecycleBus: options.lifecycleBus,
        })
    );
}
