// should-fire fixture — non-compliant: declares events?: EventBus<X> with no
// lifecycleBus option and no parenting path anywhere in the file or package.
// Expected: the lifecycle-bus-propagation rule reports a finding here.
//
// Self-contained stubs (the rule text-matches `events?: EventBus<`; it does
// not resolve the real @gobing-ai/ts-infra EventBus).
type EventMap = Record<string, (...args: never[]) => void>;
class EventBus<T extends EventMap> {
    readonly _t?: T;
    constructor(_opts?: Record<string, unknown>) {}
}

import type { DemoEvents } from './events';

export interface DemoOptions {
    /** Optional event bus for demo observability. */
    events?: EventBus<DemoEvents>;
}

export class DemoService {
    private readonly events: EventBus<DemoEvents> | undefined;

    constructor(opts: DemoOptions = {}) {
        // BUG: no lifecycleBus option, no parenting — events vanish from the
        // System Events stream. The rule must flag this API boundary.
        this.events = opts.events ?? new EventBus<DemoEvents>();
    }

    getEvents(): EventBus<DemoEvents> | undefined {
        return this.events;
    }
}
