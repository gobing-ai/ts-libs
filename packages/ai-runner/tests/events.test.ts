import { test } from 'bun:test';
import type { EventBus } from '@gobing-ai/ts-infra';
import type { AgentEvents, AiRunnerProcessEvents } from '../src/events';

test('event maps are compatible with EventBus injection shapes', () => {
    const acceptsAgentEvents = (_events: EventBus<AgentEvents> | undefined) => true;
    const acceptsProcessEvents = (_events: EventBus<AiRunnerProcessEvents> | undefined) => true;

    acceptsAgentEvents(undefined);
    acceptsProcessEvents(undefined);
});
