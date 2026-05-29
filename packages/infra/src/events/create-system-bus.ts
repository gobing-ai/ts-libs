import { EventBus } from '../event-bus/event-bus';

/**
 * Factory that creates a configured system event bus.
 */
export function createSystemBus(): EventBus<Record<string, (...args: never[]) => void>> {
    return new EventBus();
}
