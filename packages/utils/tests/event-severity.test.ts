import { describe, expect, test } from 'bun:test';
import type { EventSeverity, WithEventSeverity } from '../src/event-severity';

describe('EventSeverity', () => {
    test('is the closed info/warning/error union used by producer payloads', () => {
        const values: EventSeverity[] = ['info', 'warning', 'error'];
        const stamped: WithEventSeverity = { severity: 'info' };
        expect(values).toContain(stamped.severity);
    });
});
