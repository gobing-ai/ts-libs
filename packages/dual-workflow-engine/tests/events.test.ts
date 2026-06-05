import { describe, expect, test } from 'bun:test';
import type { EventBus } from '@gobing-ai/ts-infra';
import type { WorkflowEngineEvents } from '../src/events';

describe('WorkflowEngineEvents', () => {
    test('is compatible with the shared EventBus injection shape', () => {
        const acceptsWorkflowEvents = (_events: EventBus<WorkflowEngineEvents> | undefined) => true;

        expect(acceptsWorkflowEvents(undefined)).toBe(true);
    });
});
