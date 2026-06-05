import { describe, expect, test } from 'bun:test';
import type { EventBus } from '@gobing-ai/ts-infra';
import type { RuleEngineEvents } from '../src/events';

describe('RuleEngineEvents', () => {
    test('is compatible with the shared EventBus injection shape', () => {
        const acceptsRuleEvents = (_events: EventBus<RuleEngineEvents> | undefined) => true;

        expect(acceptsRuleEvents(undefined)).toBe(true);
    });
});
