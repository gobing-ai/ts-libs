import { describe, expect, test } from 'bun:test';
import { FSMError, RunCollisionError, WorkflowValidationError } from '../src/errors';

describe('WorkflowValidationError', () => {
    test('instantiates with message and details', () => {
        const err = new WorkflowValidationError('invalid config', { field: 'name' });
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(WorkflowValidationError);
        expect(err.message).toBe('invalid config');
        expect(err.name).toBe('WorkflowValidationError');
        expect(err.details).toEqual({ field: 'name' });
    });

    test('instantiates without details', () => {
        const err = new WorkflowValidationError('missing field');
        expect(err.details).toBeUndefined();
        expect(err.message).toBe('missing field');
    });
});

describe('FSMError', () => {
    test('instantiates with message and details', () => {
        const err = new FSMError('state not found', { stateId: 'unknown' });
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(FSMError);
        expect(err.message).toBe('state not found');
        expect(err.name).toBe('FSMError');
        expect(err.details).toEqual({ stateId: 'unknown' });
    });

    test('instantiates without details', () => {
        const err = new FSMError('transition failed');
        expect(err.details).toBeUndefined();
        expect(err.message).toBe('transition failed');
    });
});

describe('RunCollisionError', () => {
    test('instantiates with runId in message', () => {
        const err = new RunCollisionError('run-42');
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(RunCollisionError);
        expect(err.message).toBe('Workflow run "run-42" already exists');
        expect(err.name).toBe('RunCollisionError');
    });

    test('distinct runIds produce distinct messages', () => {
        const err1 = new RunCollisionError('a');
        const err2 = new RunCollisionError('b');
        expect(err1.message).toBe('Workflow run "a" already exists');
        expect(err2.message).toBe('Workflow run "b" already exists');
    });
});
