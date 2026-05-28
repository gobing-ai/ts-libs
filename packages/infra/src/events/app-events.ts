/**
 * Application event definitions — generic typed event map pattern.
 * Apps extend this with their own event types.
 */

export type AppEvents = Record<string, (...args: never[]) => void>;

export type AppInternalEvents = Record<string, (...args: never[]) => void>;
