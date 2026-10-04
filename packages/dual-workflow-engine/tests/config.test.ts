import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflowDef, loadWorkflowDefFromText, validateWorkflowDef } from '../src/config';
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

    test('W1: rejects a failure state not declared in terminalStates', () => {
        const wf =
            'name: w\ninitialState: a\nstates: [{id: a},{id: b},{id: c}]\nterminalStates: [b]\nfailureStates: [b,c]\ntransitions: [{from: a, to: b}]\n';
        expect(() => loadWorkflowDefFromText(wf)).toThrow(/must also be declared as a terminal state/);
    });

    test('W1: rejects a failure state that is not a declared state at all', () => {
        const wf =
            'name: w\ninitialState: a\nstates: [{id: a},{id: b}]\nterminalStates: [b]\nfailureStates: [nope]\ntransitions: [{from: a, to: b}]\n';
        expect(() => loadWorkflowDefFromText(wf)).toThrow(/Failure state "nope" is not declared/);
    });

    test('W1: accepts failureStates that are a subset of terminalStates', () => {
        const wf =
            'name: w\ninitialState: a\nstates: [{id: a},{id: b},{id: c}]\nterminalStates: [b,c]\nfailureStates: [c]\ntransitions: [{from: a, to: c}]\n';
        expect(() => loadWorkflowDefFromText(wf)).not.toThrow();
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

    test('parses a YAML extensions block and carries the arrays unchanged', () => {
        const wf = `name: w
kind: state-machine
extensions:
  actions: ["./exts/audit.ts"]
  guards: ["./exts/flag.ts"]
initialState: a
states:
  - id: a
  - id: b
transitions:
  - from: a
    to: b
`;
        const def = loadWorkflowDefFromText(wf);
        expect(def.extensions).toEqual({ actions: ['./exts/audit.ts'], guards: ['./exts/flag.ts'] });
    });

    test('rejects an absolute extension path at parse time', () => {
        const wf = 'name: w\ninitialState: a\nextensions: {actions: ["/abs.ts"]}\nstates: [{id: a}]\ntransitions: []\n';
        expect(() => loadWorkflowDefFromText(wf)).toThrow(/must be relative/);
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

    test('loadWorkflowDef resolves a package-specifier $schema via injected resolve + fileSystem', async () => {
        // A bundled workflow declares `$schema: "@scope/pkg/schemas/x.json"`. Validating it
        // from a cwd outside the package tree (CI temp dir, or a --compile binary) must not
        // depend on Bun.resolveSync finding the package in node_modules: that throws on a
        // clean runner. Injecting `resolve` + `fileSystem` serves the schema from memory.
        const dir = await mkdtemp(join(tmpdir(), 'workflow-pkg-schema-'));
        const workflowPath = join(dir, 'workflow.yaml');
        await writeFile(
            workflowPath,
            [
                '$schema: "@scope/pkg/schemas/wf.schema.json"',
                'name: pkg-schema-wf',
                'initialState: start',
                'states:',
                '  - id: start',
                'transitions: []',
            ].join('\n'),
        );

        const SENTINEL = '\0embedded';
        const schemaText = JSON.stringify({
            type: 'object',
            required: ['name'],
            properties: { name: { enum: ['pkg-schema-wf'] } },
        });
        const opts = {
            // ts-runtime resolves a package ref by resolving `<pkg>/package.json` then joining
            // the subpath, so the resolver is called with the manifest specifier; returning a
            // sentinel manifest path routes the subsequent read to the embedded map.
            resolve: (specifier: string) =>
                specifier === '@scope/pkg/package.json' ? `${SENTINEL}/package.json` : specifier,
            fileSystem: {
                readFile: async (path: string) => (path.startsWith(SENTINEL) ? schemaText : Bun.file(path).text()),
            },
        };

        // Resolves + validates without touching node_modules.
        expect(await loadWorkflowDef(workflowPath, opts)).toMatchObject({ name: 'pkg-schema-wf' });

        // A schema that rejects the name proves the injected schema is actually applied,
        // not silently skipped.
        const rejecting = {
            resolve: opts.resolve,
            fileSystem: {
                readFile: async (path: string) =>
                    path.startsWith(SENTINEL)
                        ? JSON.stringify({ type: 'object', properties: { name: { enum: ['other'] } } })
                        : Bun.file(path).text(),
            },
        };
        await expect(loadWorkflowDef(workflowPath, rejecting)).rejects.toThrow('failed JSON schema validation');
    });
});

describe('validateWorkflowDef — structured fork-join in transition-flow', () => {
    const validForkJoin = {
        kind: 'transition-flow' as const,
        name: 'valid-fork-join',
        initialNode: 'fork',
        terminalNodes: ['done'],
        nodes: [
            {
                id: 'fork',
                type: 'parallel' as const,
                branches: [
                    { id: 'b1', startNode: 'n1' },
                    { id: 'b2', startNode: 'n2' },
                ],
                join: 'join-node',
                joinPolicy: 'all' as const,
                failurePolicy: 'collect' as const,
            },
            { id: 'n1' },
            { id: 'n2' },
            { id: 'join-node' },
            { id: 'done' },
        ],
        edges: [
            { from: 'fork', to: 'n1' },
            { from: 'fork', to: 'n2' },
            { from: 'n1', to: 'join-node' },
            { from: 'n2', to: 'join-node' },
            { from: 'join-node', to: 'done' },
        ],
    };

    test('accepts valid structured fork-join workflow', () => {
        expect(() => validateWorkflowDef(validForkJoin)).not.toThrow();
    });

    test('fails when parallel node declares fewer than 2 branches', () => {
        const wf = {
            ...validForkJoin,
            nodes: [
                {
                    id: 'fork',
                    type: 'parallel' as const,
                    branches: [{ id: 'b1', startNode: 'n1' }],
                    join: 'join-node',
                },
                { id: 'n1' },
                { id: 'join-node' },
                { id: 'done' },
            ],
        };
        expect(() => validateWorkflowDef(wf)).toThrow(/Parallel node "fork" must declare at least 2 branches/);
    });

    test('fails when parallel node declares duplicate branch IDs', () => {
        const wf = {
            ...validForkJoin,
            nodes: [
                {
                    id: 'fork',
                    type: 'parallel' as const,
                    branches: [
                        { id: 'b1', startNode: 'n1' },
                        { id: 'b1', startNode: 'n2' },
                    ],
                    join: 'join-node',
                },
                { id: 'n1' },
                { id: 'n2' },
                { id: 'join-node' },
                { id: 'done' },
            ],
        };
        expect(() => validateWorkflowDef(wf)).toThrow(/Parallel node "fork" declares duplicate branch id "b1"/);
    });

    test('fails when branch startNode is not declared in nodes', () => {
        const wf = {
            ...validForkJoin,
            nodes: [
                {
                    id: 'fork',
                    type: 'parallel' as const,
                    branches: [
                        { id: 'b1', startNode: 'missing-node' },
                        { id: 'b2', startNode: 'n2' },
                    ],
                    join: 'join-node',
                },
                { id: 'n2' },
                { id: 'join-node' },
                { id: 'done' },
            ],
        };
        expect(() => validateWorkflowDef(wf)).toThrow(
            /Branch "b1" in parallel node "fork" references undeclared startNode "missing-node"/,
        );
    });

    test('fails when parallel node join is not declared in nodes', () => {
        const wf = {
            ...validForkJoin,
            nodes: [
                {
                    id: 'fork',
                    type: 'parallel' as const,
                    branches: [
                        { id: 'b1', startNode: 'n1' },
                        { id: 'b2', startNode: 'n2' },
                    ],
                    join: 'missing-join',
                },
                { id: 'n1' },
                { id: 'n2' },
                { id: 'done' },
            ],
        };
        expect(() => validateWorkflowDef(wf)).toThrow(
            /Parallel node "fork" references undeclared join node "missing-join"/,
        );
    });

    test('fails when parallel node join is the parallel node itself', () => {
        const wf = {
            ...validForkJoin,
            nodes: [
                {
                    id: 'fork',
                    type: 'parallel' as const,
                    branches: [
                        { id: 'b1', startNode: 'n1' },
                        { id: 'b2', startNode: 'n2' },
                    ],
                    join: 'fork',
                },
                { id: 'n1' },
                { id: 'n2' },
                { id: 'done' },
            ],
        };
        expect(() => validateWorkflowDef(wf)).toThrow(/Parallel node "fork" cannot have join set to itself/);
    });

    test('fails when branch startNode is the join node directly', () => {
        const wf = {
            ...validForkJoin,
            nodes: [
                {
                    id: 'fork',
                    type: 'parallel' as const,
                    branches: [
                        { id: 'b1', startNode: 'join-node' },
                        { id: 'b2', startNode: 'n2' },
                    ],
                    join: 'join-node',
                },
                { id: 'n2' },
                { id: 'join-node' },
                { id: 'done' },
            ],
        };
        expect(() => validateWorkflowDef(wf)).toThrow(
            /Branch "b1" in parallel node "fork" has startNode equal to join node "join-node"/,
        );
    });

    test('fails when nested parallel nodes are declared within a branch', () => {
        const wf = {
            ...validForkJoin,
            nodes: [
                {
                    id: 'fork',
                    type: 'parallel' as const,
                    branches: [
                        { id: 'b1', startNode: 'inner-fork' },
                        { id: 'b2', startNode: 'n2' },
                    ],
                    join: 'join-node',
                },
                {
                    id: 'inner-fork',
                    type: 'parallel' as const,
                    branches: [
                        { id: 'ib1', startNode: 'in1' },
                        { id: 'ib2', startNode: 'in2' },
                    ],
                    join: 'join-node',
                },
                { id: 'in1' },
                { id: 'in2' },
                { id: 'n2' },
                { id: 'join-node' },
                { id: 'done' },
            ],
            edges: [
                { from: 'fork', to: 'inner-fork' },
                { from: 'fork', to: 'n2' },
                { from: 'inner-fork', to: 'in1' },
                { from: 'inner-fork', to: 'in2' },
                { from: 'in1', to: 'join-node' },
                { from: 'in2', to: 'join-node' },
                { from: 'n2', to: 'join-node' },
                { from: 'join-node', to: 'done' },
            ],
        };
        expect(() => validateWorkflowDef(wf)).toThrow(
            /Parallel node "inner-fork" is nested inside parallel node "fork" \(nested parallel regions are forbidden\)/,
        );
    });

    test('fails when there is a cycle inside a parallel branch before reaching join', () => {
        const wf = {
            ...validForkJoin,
            edges: [
                { from: 'fork', to: 'n1' },
                { from: 'fork', to: 'n2' },
                { from: 'n1', to: 'loop1' },
                { from: 'loop1', to: 'n1' },
                { from: 'n1', to: 'join-node' },
                { from: 'n2', to: 'join-node' },
                { from: 'join-node', to: 'done' },
            ],
            nodes: [...validForkJoin.nodes, { id: 'loop1' }],
        };
        expect(() => validateWorkflowDef(wf)).toThrow(/Parallel branch "b1" in node "fork" contains a cycle/);
    });
});
