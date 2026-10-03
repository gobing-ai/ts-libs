import { describe, expect, test } from 'bun:test';
import { createDecisionMaker, type DecisionDriver, type DecisionMaker } from '@gobing-ai/ts-ai-runner';
import type { LayaWorkerClient } from '@gobing-ai/ts-laya-mlx';
import type { ProcessExecutor } from '@gobing-ai/ts-runtime';
import {
    type BuiltinMakerOptions,
    DecisionMakerRegistry,
    DecisionRegistryError,
    type MakerSource,
    UnknownDecisionMakerError,
} from '../src';

/** ProcessExecutor stub: every call fails — registry tests resolve makers but never drive an ask. */
class UnusedExecutor implements ProcessExecutor {
    run(): Promise<never> {
        return Promise.reject(new Error('registry tests must not spawn processes'));
    }

    runStreaming(): never {
        throw new Error('registry tests must not spawn processes');
    }
}

/** Minimal driver for the documented consumer pattern: `() => createDecisionMaker({ driver })`. */
function stubDriver(name: string): DecisionDriver {
    return {
        name,
        ask: () => Promise.reject(new Error(`${name} stub must not be asked`)),
    };
}

/** Resolve expected to reject; return the error for instance/field assertions. */
async function resolveFailure(promise: Promise<DecisionMaker>): Promise<unknown> {
    return promise.then(
        () => {
            throw new Error('expected the resolve to reject');
        },
        (error: unknown) => error,
    );
}

describe('DecisionMakerRegistry (AC1: makers registered by name)', () => {
    test('pre-registers the three built-in names', () => {
        const registry = new DecisionMakerRegistry();
        expect(registry.names()).toEqual(['typesafe', 'fm-local', 'laya-local']);
        expect(registry.has('typesafe')).toBe(true);
        expect(registry.has('fm-local')).toBe(true);
        expect(registry.has('laya-local')).toBe(true);
        expect(registry.has('scripted')).toBe(false);
    });

    test('registering never constructs a maker or driver', () => {
        // createFmDriver rejects off darwin/arm64 at construction: eager built-ins would make
        // this constructor throw before any resolve. names()/has() must stay side-effect free.
        const builtins: BuiltinMakerOptions = {
            driverOptions: { 'fm-local': { platform: 'win32', arch: 'x64', executor: new UnusedExecutor() } },
        };
        const registry = new DecisionMakerRegistry({ builtins });
        expect(registry.names()).toEqual(['typesafe', 'fm-local', 'laya-local']);
    });

    test('built-in factory errors propagate unchanged, not as registry errors', async () => {
        const registry = new DecisionMakerRegistry({
            builtins: {
                driverOptions: { 'fm-local': { platform: 'win32', arch: 'x64', executor: new UnusedExecutor() } },
            },
        });
        const error = await resolveFailure(registry.resolve('fm-local'));
        expect(error).not.toBeInstanceOf(DecisionRegistryError);
        expect(error).not.toBeInstanceOf(UnknownDecisionMakerError);
        expect((error as Error).message).toContain('darwin arm64');
    });

    test('resolves a scripted factory once and memoises the maker', async () => {
        let runs = 0;
        const source: MakerSource = () => {
            runs += 1;
            return createDecisionMaker({ driver: stubDriver('scripted') });
        };
        const registry = new DecisionMakerRegistry({ builtins: false });
        registry.register('scripted', source);
        expect(runs).toBe(0); // register builds nothing

        const first = await registry.resolve('scripted');
        const second = await registry.resolve('scripted');
        expect(runs).toBe(1); // factory ran exactly once
        expect(second).toBe(first); // same instance for the life of the registry
        expect(first.driver).toBe('scripted');
    });

    test('an async factory memoises its awaited maker', async () => {
        let runs = 0;
        const registry = new DecisionMakerRegistry({ builtins: false });
        registry.register('async', async () => {
            runs += 1;
            return createDecisionMaker({ driver: stubDriver('async') });
        });
        const first = await registry.resolve('async');
        expect(await registry.resolve('async')).toBe(first);
        expect(runs).toBe(1);
    });

    test('concurrent resolves share one in-flight factory run and the same instance', async () => {
        let runs = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const registry = new DecisionMakerRegistry({ builtins: false });
        registry.register('deferred', async () => {
            runs += 1;
            await gate; // hold the factory in flight until both callers have entered resolve
            return createDecisionMaker({ driver: stubDriver('deferred') });
        });

        const both = Promise.all([registry.resolve('deferred'), registry.resolve('deferred')]);
        release();
        const [first, second] = await both;
        expect(runs).toBe(1); // factory ran exactly once despite two overlapping callers
        expect(Object.is(first, second)).toBe(true);
        expect(Object.is(await registry.resolve('deferred'), first)).toBe(true); // memoised after settle
    });

    test('a rejected in-flight resolve is cleared, so a later resolve retries the factory', async () => {
        let runs = 0;
        let fixed = false;
        const registry = new DecisionMakerRegistry({ builtins: false });
        registry.register('flaky-async', async () => {
            runs += 1;
            if (!fixed) throw new Error('backend not ready');
            return createDecisionMaker({ driver: stubDriver('flaky-async') });
        });

        const settled = await Promise.allSettled([registry.resolve('flaky-async'), registry.resolve('flaky-async')]);
        expect(
            settled.map((outcome) => (outcome.status === 'rejected' ? (outcome.reason as Error).message : '')),
        ).toEqual(['backend not ready', 'backend not ready']); // both callers share the rejection
        expect(runs).toBe(1);

        fixed = true;
        const maker = await registry.resolve('flaky-async');
        expect(runs).toBe(2); // the cleared promise let the factory run again
        expect(await registry.resolve('flaky-async')).toBe(maker); // the retry success is memoised
    });

    test('a registered DecisionMaker instance resolves as-is (register chains)', async () => {
        const maker = createDecisionMaker({ driver: stubDriver('static') });
        const registry = new DecisionMakerRegistry({ builtins: false }).register('static', maker);
        expect(await registry.resolve('static')).toBe(maker);
    });

    test('resolving an unknown name throws UnknownDecisionMakerError carrying the name', async () => {
        const registry = new DecisionMakerRegistry();
        const error = await resolveFailure(registry.resolve('nope'));
        expect(error).toBeInstanceOf(UnknownDecisionMakerError);
        expect((error as UnknownDecisionMakerError).name).toBe('nope');
    });

    test('a duplicate registration throws and keeps the first source', () => {
        const registry = new DecisionMakerRegistry();
        const original = createDecisionMaker({ driver: stubDriver('original') });
        registry.register('original', original);
        expect(() => registry.register('typesafe', () => createDecisionMaker())).toThrow(DecisionRegistryError);
        expect(() => registry.register('original', () => createDecisionMaker())).toThrow(DecisionRegistryError);
    });

    test('an invalid name throws DecisionRegistryError', () => {
        const registry = new DecisionMakerRegistry({ builtins: false });
        for (const bad of ['', 'Typesafe', 'fm_local', '9lives', 'has space', '-lead']) {
            expect(() => registry.register(bad, () => createDecisionMaker())).toThrow(DecisionRegistryError);
        }
        expect(registry.names()).toEqual([]);
    });

    test('a throwing factory is not memoised — the next resolve retries', async () => {
        let runs = 0;
        let fixed = false;
        const registry = new DecisionMakerRegistry({ builtins: false });
        registry.register('flaky', () => {
            runs += 1;
            if (!fixed) throw new Error('backend not ready');
            return createDecisionMaker({ driver: stubDriver('flaky') });
        });

        const firstError = await resolveFailure(registry.resolve('flaky'));
        expect((firstError as Error).message).toBe('backend not ready'); // propagates unchanged
        expect(runs).toBe(1);

        fixed = true;
        const maker = await registry.resolve('flaky');
        expect(runs).toBe(2); // retried, the failure was not memoised
        expect(maker.driver).toBe('flaky');
        expect(await registry.resolve('flaky')).toBe(maker); // the success is memoised
    });

    test('fm-local resolves on the injected driver options and keeps its driver identity', async () => {
        const registry = new DecisionMakerRegistry({
            builtins: {
                driverOptions: { 'fm-local': { platform: 'darwin', arch: 'arm64', executor: new UnusedExecutor() } },
            },
        });
        const maker = await registry.resolve('fm-local');
        expect(maker.driver).toBe('fm-local'); // wired to the fm driver, not a fallback
        expect(await registry.resolve('fm-local')).toBe(maker); // memoised built-in
    });

    test('laya-local resolves on the injected driver options and keeps its driver identity', async () => {
        const client = {
            ask: () => Promise.reject(new Error('laya stub must not be asked')),
        } as unknown as LayaWorkerClient; // never asked; only construction identity is asserted
        const registry = new DecisionMakerRegistry({
            builtins: { driverOptions: { 'laya-local': { client } } },
        });
        const maker = await registry.resolve('laya-local');
        expect(maker.driver).toBe('laya-local');
        expect(await registry.resolve('laya-local')).toBe(maker);
    });

    test('typesafe resolves through createDecisionMaker and is memoised', async () => {
        const registry = new DecisionMakerRegistry({
            builtins: { makerOptions: { env: { TYPESAFE_API_KEY: 'test-key' } } },
        });
        const maker = await registry.resolve('typesafe');
        expect(maker.driver).toBe('typesafe');
        expect(await registry.resolve('typesafe')).toBe(maker);
    });

    test('builtins: false registers nothing', async () => {
        const registry = new DecisionMakerRegistry({ builtins: false });
        expect(registry.names()).toEqual([]);
        expect(registry.has('typesafe')).toBe(false);
        const error = await resolveFailure(registry.resolve('typesafe'));
        expect(error).toBeInstanceOf(UnknownDecisionMakerError);
    });
});
