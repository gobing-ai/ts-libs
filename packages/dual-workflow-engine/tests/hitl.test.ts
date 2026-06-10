import { describe, expect, test } from 'bun:test';
import type { HitlAnswer, HitlRequest, HitlRequestKind, HitlResponder } from '../src/hitl';

describe('HitlResponder contract', () => {
    test('HitlRequest union discriminates on kind', () => {
        // Confirm the type system accepts the contract shape.
        const req: HitlRequest = {
            kind: 'confirm' as HitlRequestKind,
            prompt: 'Proceed?',
            options: ['yes', 'no'],
            runId: 'r1',
            node: 'gate',
        };
        expect(req.kind).toBe('confirm');
    });

    test('HitlAnswer carries cancel flag', () => {
        const answer: HitlAnswer = { value: 'no', cancelled: true };
        expect(answer.cancelled).toBe(true);
    });

    test('HitlResponder is assignable', () => {
        const responder: HitlResponder = {
            async respond(_req) {
                return { value: 'yes' };
            },
        };
        expect(responder).toBeDefined();
    });
});
