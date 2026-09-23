import { describe, expect, it } from 'bun:test';
import { entropyConfidence, estimateChoice, estimateNoul, estimateScore } from '../src/estimate';

describe('sample-frequency estimation (task 0084 R6 / design § Probability estimation)', () => {
    describe('entropyConfidence', () => {
        it('is 1 for a one-hot distribution and 0 for uniform', () => {
            expect(entropyConfidence([1, 0])).toBe(1);
            expect(entropyConfidence([0.5, 0.5])).toBeCloseTo(0, 12);
            expect(entropyConfidence([1 / 3, 1 / 3, 1 / 3])).toBeCloseTo(0, 12);
        });

        it('is 1 when there is a single option', () => {
            expect(entropyConfidence([1])).toBe(1);
        });
    });

    describe('estimateChoice', () => {
        it('gives every declared label a frequency, unsampled labels 0', () => {
            const answer = estimateChoice(['a', 'b', 'c'], ['a', 'c', 'a', 'a']);
            expect(answer.probabilities).toEqual({ a: 0.75, b: 0, c: 0.25 });
            expect(answer.label).toBe('a');
            expect(answer.kind).toBe('choice');
        });

        it('breaks ties by label declaration order', () => {
            const answer = estimateChoice(['z', 'a'], ['z', 'a']);
            expect(answer.label).toBe('z');
            expect(answer.probabilities).toEqual({ z: 0.5, a: 0.5 });
        });

        it('with k=1 is one-hot with confidence 1', () => {
            const answer = estimateChoice(['no', 'yes'], ['yes']);
            expect(answer.label).toBe('yes');
            expect(answer.probabilities).toEqual({ no: 0, yes: 1 });
            expect(answer.confidence).toBe(1);
        });
    });

    describe('estimateScore', () => {
        it('counts levels, ties go to the lower level, legend maps rubric text', () => {
            const rubric = ['low', 'mid', 'high'] as const;
            const answer = estimateScore(rubric, ['0', '2', '1', '2']);
            expect(answer.score).toBe(2);
            expect(answer.probabilities).toEqual({ 0: 0.25, 1: 0.25, 2: 0.5 });
            expect(answer.legend).toEqual({ 0: 'low', 1: 'mid', 2: 'high' });
        });

        it('prefers the lower level on an even split', () => {
            const answer = estimateScore(['low', 'high'] as const, ['0', '1']);
            expect(answer.score).toBe(0);
            expect(answer.confidence).toBeCloseTo(0, 12);
        });

        it('with k=1 is one-hot with confidence 1', () => {
            const answer = estimateScore(['low', 'high'] as const, ['1']);
            expect(answer.score).toBe(1);
            expect(answer.probabilities).toEqual({ 0: 0, 1: 1 });
            expect(answer.confidence).toBe(1);
        });
    });

    describe('estimateNoul', () => {
        it('returns the yes fraction and no confidence key', () => {
            const answer = estimateNoul(['yes', 'no', 'yes', 'yes']);
            expect(answer).toEqual({ kind: 'noul', probability: 0.75 });
            expect('confidence' in answer).toBe(false);
        });

        it('all-no samples give probability 0', () => {
            expect(estimateNoul(['no', 'no'])).toEqual({ kind: 'noul', probability: 0 });
        });
    });
});
