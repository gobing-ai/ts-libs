import { describe, expect, test } from 'bun:test';
import { loadWorkflowDefFromText } from '../src/config';
import { WorkflowValidationError } from '../src/errors';
import type { StateMachineWorkflowDef } from '../src/types';

const MINIMAL_YAML = `
name: test-wf
version: '1.0'
states:
  - id: init
    onEnter:
      - kind: note
        options:
          message: "starting"
  - id: done
initialState: init
terminalStates:
  - done
transitions:
  - from: init
    to: done
    guard:
      kind: always
`;

describe('loadWorkflowDefFromText', () => {
    test('parses minimal valid state-machine YAML', () => {
        const def = loadWorkflowDefFromText(MINIMAL_YAML) as StateMachineWorkflowDef;
        expect(def.name).toBe('test-wf');
        expect(def.initialState).toBe('init');
        expect(def.states).toHaveLength(2);
        expect(def.states[0]?.id).toBe('init');
        expect(def.states[1]?.id).toBe('done');
        expect(def.terminalStates).toEqual(['done']);
        expect(def.transitions).toHaveLength(1);
        expect(def.transitions[0]).toMatchObject({ from: 'init', to: 'done' });
        expect(def.transitions[0]?.guard).toMatchObject({ kind: 'always' });
    });

    test('parses minimal valid state-machine YAML as JSON string', () => {
        const json = JSON.stringify({
            name: 'json-wf',
            states: [{ id: 'start' }, { id: 'end' }],
            initialState: 'start',
            terminalStates: ['end'],
            transitions: [{ from: 'start', to: 'end' }],
        });
        const def = loadWorkflowDefFromText(json) as StateMachineWorkflowDef;
        expect(def.name).toBe('json-wf');
        expect(def.initialState).toBe('start');
        expect(def.states).toHaveLength(2);
    });

    test('throws on invalid YAML', () => {
        expect(() => loadWorkflowDefFromText('{ invalid yaml: {{{')).toThrow();
    });

    test('throws ValidationError when missing required fields', () => {
        expect(() => loadWorkflowDefFromText('name: only-name')).toThrow(WorkflowValidationError);
    });

    test('throws ValidationError when initialState references undeclared state', () => {
        const invalid = `
name: bad
states:
  - id: s1
initialState: missing-state
transitions: []
`;
        expect(() => loadWorkflowDefFromText(invalid)).toThrow(WorkflowValidationError);
    });

    test('throws ValidationError when transition references undeclared state', () => {
        const invalid = `
name: bad
states:
  - id: s1
initialState: s1
transitions:
  - from: s1
    to: ghost
`;
        expect(() => loadWorkflowDefFromText(invalid)).toThrow(WorkflowValidationError);
    });

    test('includes source name in validation error message', () => {
        expect(() => loadWorkflowDefFromText('bogus: true', 'my-file.yaml')).toThrow('my-file.yaml');
    });
});
