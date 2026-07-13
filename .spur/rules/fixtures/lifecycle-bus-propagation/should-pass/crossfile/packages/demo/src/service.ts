// Sibling service for the cross-file should-pass fixture — owns the
// lifecycleBus propagation path for DemoRunOptions.events declared in
// options.ts. Mirrors the dual-workflow-engine shape (WorkflowRunOptions in
// types.ts, parenting in service.ts).
//
// Self-contained stubs (the rule text-matches `lifecycleBus`).
type EventMap = Record<string, (...args: never[]) => void>;
type BusLifecycleEvents = { [event: string]: (...args: never[]) => void };
class EventBus<T extends EventMap> {
    readonly _t?: T;
    constructor(_opts?: { lifecycleBus?: EventBus<BusLifecycleEvents> }) {}
}

import type { DemoEvents } from './events';
import type { DemoRunOptions } from './options';

export class DemoService {
    constructor(private readonly lifecycleBus?: EventBus<BusLifecycleEvents>) {}

    resolveEvents(events?: EventBus<DemoEvents>): EventBus<DemoEvents> | undefined {
        return (
            events ?? (this.lifecycleBus ? new EventBus<DemoEvents>({ lifecycleBus: this.lifecycleBus }) : undefined)
        );
    }
}

export function runDemo(options: DemoRunOptions): void {
    void options.events;
}
