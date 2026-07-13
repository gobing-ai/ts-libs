// should-pass fixture (shape 2: constructor-on-service, cross-file) —
// compliant: the per-run options type declares events?: EventBus<X> with no
// file-local lifecycleBus, but a sibling service class in the same package src
// dir carries the lifecycleBus param + parenting. The rule's package-level
// check must pass this. Expected: no finding.
//
// Self-contained stubs (the rule text-matches `events?: EventBus<`).
type EventMap = Record<string, (...args: never[]) => void>;
class EventBus<T extends EventMap> {
    readonly _t?: T;
    constructor(_opts?: { lifecycleBus?: EventBus<never> }) {}
}

import type { DemoEvents } from './events';

export interface DemoRunOptions {
    readonly events?: EventBus<DemoEvents>;
}
