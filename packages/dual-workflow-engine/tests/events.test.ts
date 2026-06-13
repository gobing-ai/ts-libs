import { describe, expect, test } from 'bun:test';
import type { EventBus } from '@gobing-ai/ts-infra';
import type { WorkflowEngineEvents } from '../src/events';

describe('WorkflowEngineEvents', () => {
    test('is compatible with the shared EventBus injection shape', () => {
        const acceptsWorkflowEvents = (_events: EventBus<WorkflowEngineEvents> | undefined) => true;
        expect(acceptsWorkflowEvents(undefined)).toBe(true);
    });

    test('README Event Map is the single source of truth — event names match type', async () => {
        // Read the README and extract the event table rows
        const readme = await Bun.file(`${import.meta.dir}/../README.md`).text();
        // Match event names in the Event Map table (lines starting with `| \`workflow.`)
        const readmeEvents = [...readme.matchAll(/^\| `(workflow\.[a-z_.]+)` \|/gm)].map((m) => m[1]).sort();

        // Known event set from events.ts — update this if events change
        const knownEvents = [
            'workflow.action.done',
            'workflow.action.failed_continue',
            'workflow.action.start',
            'workflow.custom',
            'workflow.guard.evaluated',
            'workflow.hitl.ask',
            'workflow.hitl.note',
            'workflow.hitl.response',
            'workflow.node.enter',
            'workflow.node.transition',
            'workflow.run.done',
            'workflow.run.failed',
            'workflow.run.paused',
            'workflow.run.reseeded',
            'workflow.run.resumed',
            'workflow.run.started',
            'workflow.transition.denied',
            'workflow.transition.requested',
        ].sort();

        expect(readmeEvents.length).toBe(knownEvents.length);
        // If this fails, the README Event Map table is out of sync with knownEvents.
        // 1. Update the README first (it is the SSOT)
        // 2. Then update knownEvents here to match
        expect(readmeEvents).toEqual(knownEvents);
    });
});
