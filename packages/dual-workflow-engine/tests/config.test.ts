import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflowDef, loadWorkflowDefFromText } from '../src/config';
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

    test('preserves description on the workflow, states, and transitions', () => {
        const yaml = `
name: documented
description: top-level purpose
initialState: a
terminalStates: [b]
states:
  - id: a
    description: the start state
  - id: b
transitions:
  - from: a
    to: b
    description: move when done
`;
        const def = loadWorkflowDefFromText(yaml) as StateMachineWorkflowDef;
        expect(def.description).toBe('top-level purpose');
        expect(def.states[0]?.description).toBe('the start state');
        expect(def.transitions[0]?.description).toBe('move when done');
    });

    test('schema error names the offending field path, not a generic message', () => {
        // initialState must be a non-empty string; an empty value should be pinpointed.
        const invalid = 'name: x\ninitialState: ""\nstates: [{ id: a }]\ntransitions: []\n';
        expect(() => loadWorkflowDefFromText(invalid)).toThrow(/initialState/);
    });

    test('W1: rejects duplicate state ids', () => {
        const wf =
            'name: w\ninitialState: a\nstates: [{id: a},{id: a},{id: b}]\nterminalStates: [b]\ntransitions: [{from: a, to: b}]\n';
        expect(() => loadWorkflowDefFromText(wf)).toThrow(/declared more than once/);
    });

    test('W1: rejects an initial state that is also terminal', () => {
        const wf = 'name: w\ninitialState: a\nstates: [{id: a}]\nterminalStates: [a]\ntransitions: []\n';
        expect(() => loadWorkflowDefFromText(wf)).toThrow(/must not be a terminal state/);
    });

    test('W1: rejects an explicit terminal state that declares transitions', () => {
        const wf =
            'name: w\ninitialState: a\nstates: [{id: a},{id: b}]\nterminalStates: [b]\ntransitions: [{from: a, to: b},{from: b, to: a}]\n';
        expect(() => loadWorkflowDefFromText(wf)).toThrow(/Terminal state "b" must not declare transitions/);
    });

    // `REF(x)` builds a literal `${x}` template placeholder without writing `${` in
    // source (which would trip the noTemplateCurlyInString lint on these fixtures).
    const REF = (expr: string) => `\${${expr}}`;

    test('W1: rejects an unknown vars reference in action options', () => {
        const message = `Implementing ${REF('vars.nope')}`;
        const wf = `name: w\ninitialState: a\nstates: [{id: a, onEnter: [{kind: note, options: {message: "${message}"}}]},{id: b}]\nterminalStates: [b]\ntransitions: [{from: a, to: b}]\n`;
        expect(() => loadWorkflowDefFromText(wf)).toThrow(/Unknown variable reference/);
    });

    test('W1: allows declared vars and reserved runtime namespaces (no placeholder)', () => {
        const message = `${REF('vars.greeting')} ${REF('workflow')} ${REF('runId')} ${REF('task')} ${REF('runtime')}`;
        const wf = `name: w\ninitialState: a\nvars: {greeting: hi}\nstates: [{id: a, onEnter: [{kind: note, options: {message: "${message}"}}]},{id: b}]\nterminalStates: [b]\ntransitions: [{from: a, to: b}]\n`;
        expect(loadWorkflowDefFromText(wf).name).toBe('w');
    });

    test('W2: rejects a reserved variable name', () => {
        const wf = 'name: w\ninitialState: a\nvars: {task: x}\nstates: [{id: a}]\ntransitions: []\n';
        expect(() => loadWorkflowDefFromText(wf)).toThrow(/reserved/);
    });

    test('W2: rejects an invalid variable identifier', () => {
        const wf = 'name: w\ninitialState: a\nvars: {"1bad": x}\nstates: [{id: a}]\ntransitions: []\n';
        expect(() => loadWorkflowDefFromText(wf)).toThrow(/valid identifier/);
    });

    test('R7: strict mode rejects an unknown top-level key (old field name)', () => {
        // `initial` was the old field name; the new schema uses `initialState`.
        const wf = 'name: w\ninitial: a\nstates: [{id: a}]\ntransitions: []\n';
        expect(() => loadWorkflowDefFromText(wf)).toThrow();
    });

    test('accepts an optional top-level version tag', () => {
        const wf = 'name: w\nversion: "2"\ninitialState: a\nstates: [{id: a}]\ntransitions: []\n';
        expect(loadWorkflowDefFromText(wf).version).toBe('2');
    });

    test('loadWorkflowDef honors $schema validation by default', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'workflow-schema-'));
        const schemaPath = join(dir, 'workflow.schema.json');
        const workflowPath = join(dir, 'workflow.yaml');
        await writeFile(
            schemaPath,
            JSON.stringify({
                type: 'object',
                additionalProperties: false,
                required: ['name', 'initialState', 'states', 'transitions'],
                properties: {
                    $schema: { type: 'string' },
                    name: { type: 'string' },
                    initialState: { type: 'string' },
                    states: { type: 'array', items: { type: 'object' } },
                    transitions: { type: 'array', items: { type: 'object' } },
                },
            }),
        );
        // The referenced JSON Schema forbids the `extra` key (additionalProperties:false),
        // so $schema validation must reject it; skipping $schema validation should not.
        // (`extra` is also stripped by the engine's own strict Zod schema, so the file is
        // authored without it and the JSON-Schema layer is what differentiates the two runs.)
        await writeFile(
            schemaPath,
            JSON.stringify({
                type: 'object',
                additionalProperties: false,
                required: ['name'],
                properties: {
                    $schema: { type: 'string' },
                    name: { enum: ['expected-name'] },
                    initialState: { type: 'string' },
                    states: { type: 'array', items: { type: 'object' } },
                    transitions: { type: 'array', items: { type: 'object' } },
                },
            }),
        );
        await writeFile(
            workflowPath,
            '$schema: ./workflow.schema.json\nname: invalid\ninitialState: start\nstates:\n  - id: start\ntransitions: []\n',
        );

        await expect(loadWorkflowDef(workflowPath)).rejects.toThrow('failed JSON schema validation');
        expect(await loadWorkflowDef(workflowPath, { validateSchema: false })).toMatchObject({ name: 'invalid' });
    });
});
