import { describe, expect, it } from 'bun:test';
import { q } from '@gobing-ai/ts-ai-runner';
import { buildFmSchema, buildPrompt, declaredOptions, FM_INSTRUCTIONS, formatDesc } from '../src/schema';

describe('fm schema construction (task 0084 R3 / AC5)', () => {
    it('lists every key under x-order, required, with additionalProperties false', () => {
        const schema = buildFmSchema({
            dept: q.choice('Pick a team', { billing: 'Invoices', tech: 'Bugs' }),
            urgent: q.score('How urgent?', ['Low', 'High']),
            refund: q.noul('Should we refund?'),
        });
        expect(schema.type).toBe('object');
        expect(schema.title).toBe('Decision');
        expect(schema['x-order']).toEqual(['dept', 'urgent', 'refund']);
        expect(schema.required).toEqual(['dept', 'urgent', 'refund']);
        expect(schema.additionalProperties).toBe(false);
    });

    it('uses string enums: labels, "0"…"n-1" score levels, ["yes","no"] noul', () => {
        const schema = buildFmSchema({
            dept: q.choice('Pick', { billing: 'Invoices', tech: 'Bugs', sales: 'Deals' }),
            urgent: q.score('How urgent?', ['Low', 'Medium', 'High']),
            refund: q.noul(),
        });
        expect(schema.properties.dept).toEqual({ type: 'string', enum: ['billing', 'tech', 'sales'] });
        expect(schema.properties.urgent).toEqual({ type: 'string', enum: ['0', '1', '2'] });
        expect(schema.properties.refund).toEqual({ type: 'string', enum: ['yes', 'no'] });
    });

    it('preserves question declaration order for the enum of choice labels', () => {
        const schema = buildFmSchema({ pick: q.choice('Pick', { z: 'last', a: 'first' }) });
        expect(schema.properties.pick?.enum).toEqual(['z', 'a']);
    });

    it('never contains a confidence field anywhere', () => {
        const schema = buildFmSchema({
            dept: q.choice('Pick', { a: 'A', b: 'B' }),
            refund: q.noul(),
        });
        expect(JSON.stringify(schema).toLowerCase()).not.toContain('confidence');
    });
});

describe('fm prompt and instructions (task 0084 design § Request construction)', () => {
    it('instructions never ask for confidence or probability', () => {
        const lower = FM_INSTRUCTIONS.toLowerCase();
        expect(lower).not.toContain('confidence');
        expect(lower).not.toContain('probability');
        expect(lower).toContain('every question');
    });

    it('renders a string state verbatim before the question blocks', () => {
        const prompt = buildPrompt('Invoice was double billed', {
            dept: q.choice('Pick a team', { billing: 'Invoices, refunds' }),
        });
        expect(prompt).toContain('Invoice was double billed');
        expect(prompt).toContain('Question "dept": Pick a team');
        expect(prompt).toContain('- billing: Invoices, refunds');
    });

    it('JSON-stringifies a structured state', () => {
        const prompt = buildPrompt(
            { amount: 120, currency: 'USD' },
            {
                refund: q.noul('Refund?'),
            },
        );
        expect(prompt).toContain('{"amount":120,"currency":"USD"}');
    });

    it('renders score levels as indices with rubric text and noul outcomes', () => {
        const prompt = buildPrompt(null, {
            urgent: q.score('How urgent?', ['Low priority', null, 'Drop everything']),
            refund: q.noul('Refund?', { yes: 'Return the money', no: 'Deny' }),
        });
        expect(prompt).toContain('- 0: Low priority');
        expect(prompt).toContain('- 1');
        expect(prompt).toContain('- 2: Drop everything');
        expect(prompt).toContain('- yes: Return the money');
        expect(prompt).toContain('- no: Deny');
    });

    it('keeps formatDesc/declaredOptions consistent: strings verbatim, structured JSON', () => {
        expect(formatDesc('plain')).toBe('plain');
        expect(formatDesc({ reason: 'x' })).toBe('{"reason":"x"}');
        expect(formatDesc(null)).toBe('');
        expect(formatDesc(undefined)).toBe('');
        expect(declaredOptions(q.score('s', ['a', 'b']))).toEqual(['0', '1']);
        expect(declaredOptions(q.noul())).toEqual(['yes', 'no']);
    });
});
