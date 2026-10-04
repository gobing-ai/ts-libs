import { describe, expect, test } from 'bun:test';
import { loadWorkflowDefFromText, validateWorkflowDef } from '../src/config';
import { DagWorkflowDefSchema } from '../src/schema';
import type { DagWorkflowDef } from '../src/types';

describe('DagWorkflowDefSchema (task 0099)', () => {
    const minimalDag = {
        kind: 'dag' as const,
        name: 'test-dag',
        nodes: [
            { id: 'a', action: { kind: 'note', options: { message: 'first' } } },
            { id: 'b', dependsOn: ['a'], dependencyPolicy: 'all' as const },
        ],
    };

    test('accepts valid minimal DAG workflow definition', () => {
        const result = DagWorkflowDefSchema.safeParse(minimalDag);
        expect(result.success).toBe(true);
        expect(result.data?.kind).toBe('dag');
    });

    test('accepts optional fields (version, description, iterationBound, vars, env)', () => {
        const fullDag = {
            kind: 'dag' as const,
            name: 'full-dag',
            version: '1.0',
            description: 'A complete DAG workflow',
            iterationBound: 50,
            defaultOnError: 'continue' as const,
            vars: { env_name: 'prod' },
            nodes: [
                {
                    id: 'step1',
                    action: { kind: 'note' },
                    description: 'initial step',
                    pause: false,
                    resumeRerun: true,
                },
                {
                    id: 'step2',
                    dependsOn: ['step1'],
                    dependencyPolicy: 'any' as const,
                    condition: { kind: 'always' },
                },
            ],
        };
        const result = DagWorkflowDefSchema.safeParse(fullDag);
        expect(result.success).toBe(true);
    });

    test('rejects missing kind or wrong kind', () => {
        const result = DagWorkflowDefSchema.safeParse({
            name: 'no-kind',
            nodes: [{ id: 'a' }],
        });
        expect(result.success).toBe(false);
    });

    test('rejects invalid dependencyPolicy', () => {
        const result = DagWorkflowDefSchema.safeParse({
            ...minimalDag,
            nodes: [{ id: 'a', dependsOn: ['x'], dependencyPolicy: 'majority' }],
        });
        expect(result.success).toBe(false);
    });

    test('rejects unknown top-level properties', () => {
        const result = DagWorkflowDefSchema.safeParse({
            ...minimalDag,
            unknownProp: 'bad',
        });
        expect(result.success).toBe(false);
    });
});

describe('validateWorkflowDef — DAG validation and cycle rejection (task 0099)', () => {
    test('accepts valid diamond DAG without cycles', () => {
        const diamond: DagWorkflowDef = {
            kind: 'dag',
            name: 'diamond-dag',
            nodes: [
                { id: 'start', action: { kind: 'note' } },
                { id: 'left', dependsOn: ['start'] },
                { id: 'right', dependsOn: ['start'] },
                { id: 'join', dependsOn: ['left', 'right'] },
            ],
        };
        expect(() => validateWorkflowDef(diamond)).not.toThrow();
    });

    test('fails when node references undeclared dependency', () => {
        const invalid: DagWorkflowDef = {
            kind: 'dag',
            name: 'missing-dep',
            nodes: [{ id: 'step1' }, { id: 'step2', dependsOn: ['missing-parent'] }],
        };
        expect(() => validateWorkflowDef(invalid)).toThrow(
            /Node "step2" references undeclared dependency "missing-parent"/,
        );
    });

    test('fails when node depends on itself', () => {
        const selfDep: DagWorkflowDef = {
            kind: 'dag',
            name: 'self-dep',
            nodes: [{ id: 'loop', dependsOn: ['loop'] }],
        };
        expect(() => validateWorkflowDef(selfDep)).toThrow(/Node "loop" cannot depend on itself/);
    });

    test('fails when direct 2-node cycle exists', () => {
        const cycle: DagWorkflowDef = {
            kind: 'dag',
            name: 'direct-cycle',
            nodes: [
                { id: 'a', dependsOn: ['b'] },
                { id: 'b', dependsOn: ['a'] },
            ],
        };
        expect(() => validateWorkflowDef(cycle)).toThrow(/Cycle detected in DAG dependencies/);
    });

    test('fails when indirect 3-node cycle exists', () => {
        const cycle: DagWorkflowDef = {
            kind: 'dag',
            name: 'indirect-cycle',
            nodes: [
                { id: 'a', dependsOn: ['c'] },
                { id: 'b', dependsOn: ['a'] },
                { id: 'c', dependsOn: ['b'] },
            ],
        };
        expect(() => validateWorkflowDef(cycle)).toThrow(/Cycle detected in DAG dependencies/);
    });

    test('fails when duplicate node IDs are declared', () => {
        const dupe: DagWorkflowDef = {
            kind: 'dag',
            name: 'dupe-nodes',
            nodes: [{ id: 'step1' }, { id: 'step1' }],
        };
        expect(() => validateWorkflowDef(dupe)).toThrow(/Node "step1" is declared more than once/);
    });

    test('loadWorkflowDefFromText parses DAG workflow and validates', () => {
        const yaml = `
kind: dag
name: loaded-dag
vars:
  author: robin
nodes:
  - id: step1
    action:
      kind: note
      options:
        message: "Hello \${vars.author}"
  - id: step2
    dependsOn:
      - step1
`;
        const wf = loadWorkflowDefFromText(yaml);
        expect(wf.kind).toBe('dag');
        expect(wf.name).toBe('loaded-dag');
    });
});
