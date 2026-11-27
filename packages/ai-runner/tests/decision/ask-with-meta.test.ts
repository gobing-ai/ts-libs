import { describe, expect, test } from 'bun:test';
import { createDecisionMaker } from '../../src/decision/decision-maker';
import type { Answer, DecisionDriver } from '../../src/decision/types';
import { q } from '../../src/decision/types';

/**
 * `askWithMeta` (P12 R1/R2): an OPTIONAL sibling of `ask` that also reports the model the driver
 * actually served. `ask` keeps its return shape, so no existing caller or custom driver changes.
 */

/** A driver that answers `noul` yes and implements the meta seam, reporting a served model. */
function metaDriver(servedModel?: string): DecisionDriver {
    const answers = { ready: { kind: 'noul', probability: 0.9 } as Answer };
    return {
        name: 'meta',
        async ask() {
            return answers;
        },
        async askWithMeta() {
            return { answers, ...(servedModel === undefined ? {} : { servedModel }) };
        },
    };
}

/** A driver that implements only `ask` — the shape every existing driver still has. */
function plainDriver(): DecisionDriver {
    return {
        name: 'plain',
        async ask() {
            return { ready: { kind: 'noul', probability: 0.9 } as Answer };
        },
    };
}

describe('askWithMeta (P12 R1/R2)', () => {
    test('R2 — a driver without askWithMeta still answers, with no servedModel', async () => {
        const maker = createDecisionMaker({ driver: plainDriver() });
        const meta = await maker.askWithMeta({ state: 's', questions: { ready: q.noul('ready?') } });
        expect(meta.answers.ready).toMatchObject({ kind: 'noul' });
        // Absent, not undefined-valued: the key must not appear on a driver that reported nothing.
        expect(Object.keys(meta)).toEqual(['answers']);
    });

    test('R2 — a driver with askWithMeta contributes its servedModel', async () => {
        const maker = createDecisionMaker({ driver: metaDriver('m-x') });
        const meta = await maker.askWithMeta({ state: 's', questions: { ready: q.noul('ready?') } });
        expect(meta.servedModel).toBe('m-x');
        expect(meta.answers.ready).toMatchObject({ kind: 'noul' });
    });

    test('R1 — ask keeps its Answer record return shape', async () => {
        const maker = createDecisionMaker({ driver: metaDriver('m-x') });
        const answers = await maker.ask({ state: 's', questions: { ready: q.noul('ready?') } });
        expect(answers.ready).toMatchObject({ kind: 'noul' });
        expect((answers as Record<string, unknown>).servedModel).toBeUndefined();
    });

    test('R2 — askWithMeta validates answers exactly as ask does', async () => {
        const bad: DecisionDriver = {
            name: 'bad',
            async ask() {
                return {};
            },
            async askWithMeta() {
                return { answers: {}, servedModel: 'm-x' };
            },
        };
        const maker = createDecisionMaker({ driver: bad });
        const askErr = await maker.ask({ state: 's', questions: { ready: q.noul('ready?') } }).then(
            () => null,
            (err: unknown) => err,
        );
        const metaErr = await maker.askWithMeta({ state: 's', questions: { ready: q.noul('ready?') } }).then(
            () => null,
            (err: unknown) => err,
        );
        expect(askErr).not.toBeNull();
        expect(metaErr?.constructor).toBe(askErr?.constructor);
        expect((metaErr as Error).message).toBe((askErr as Error).message);
    });
});
