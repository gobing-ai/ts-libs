import { describe, expect, test } from 'bun:test';
import { createDecisionMaker, DecisionConfigError, type DecisionDriver } from '@gobing-ai/ts-ai-runner';
import type { LayaDriverOptions, LayaWorkerClient } from '@gobing-ai/ts-laya-mlx';
import {
    DecisionHub,
    DecisionMakerRegistry,
    type LayaLocalDriverOptions,
    parseDecisionCatalog,
    resolveBundledLayaDriver,
} from '../src';

/** Import stand-in for a host whose installer skipped the macOS-only package. */
function missingPackage(): Promise<never> {
    return Promise.reject(new Error("Cannot find package '@gobing-ai/ts-laya-mlx'"));
}

const CATALOG = `version: 1
decisions:
  pick:
    type: choice
    criteria: { a: First, b: Second }
    fallback: a
    maker: laya-local
`;

describe('laya-local when the Apple-only package is not installed (ADR-041)', () => {
    test('an import failure becomes LAYA_BACKEND and keeps the cause', async () => {
        const cause = new Error("Cannot find package '@gobing-ai/ts-laya-mlx'");
        const error = await resolveBundledLayaDriver({}, () => Promise.reject(cause)).then(
            () => {
                throw new Error('expected the resolve to reject');
            },
            (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(DecisionConfigError);
        expect((error as DecisionConfigError).variable).toBe('LAYA_BACKEND');
        expect((error as Error).message).toContain("requires '@gobing-ai/ts-laya-mlx'");
        expect((error as Error).message).toContain('optional dependency installed only on macOS');
        expect((error as Error).message).toContain('bun add @gobing-ai/ts-laya-mlx');
        expect((error as DecisionConfigError & { cause?: unknown }).cause).toBe(cause);
    });

    test('a module without createLayaDriver is LAYA_BACKEND, including a non-object module', async () => {
        for (const load of [() => Promise.resolve({}), () => Promise.resolve(null), () => Promise.resolve('mlx')]) {
            const error = await resolveBundledLayaDriver({}, load).then(
                () => {
                    throw new Error('expected the resolve to reject');
                },
                (caught: unknown) => caught,
            );
            expect(error).toBeInstanceOf(DecisionConfigError);
            expect((error as DecisionConfigError).variable).toBe('LAYA_BACKEND');
            expect((error as Error).message).toContain('does not export createLayaDriver');
        }
    });

    test('a factory error from createLayaDriver propagates unchanged', async () => {
        const construction = new DecisionConfigError('bad core', 'LAYA_CORE');
        const error = await resolveBundledLayaDriver({}, () =>
            Promise.resolve({
                createLayaDriver: () => {
                    throw construction;
                },
            }),
        ).then(
            () => {
                throw new Error('expected the resolve to reject');
            },
            (caught: unknown) => caught,
        );
        expect(error).toBe(construction);
    });

    test('a resolved module receives the driver options and returns its driver', async () => {
        const seen: unknown[] = [];
        const driver: DecisionDriver = {
            name: 'laya-local',
            ask: () => Promise.reject(new Error('not asked')),
        };
        const resolved = await resolveBundledLayaDriver({ core: 'mlx-python', modelId: 'm' }, () =>
            Promise.resolve({
                createLayaDriver: (options: LayaLocalDriverOptions) => {
                    seen.push(options);
                    return driver;
                },
            }),
        );
        expect(resolved).toBe(driver);
        expect(seen).toEqual([{ core: 'mlx-python', modelId: 'm' }]);
    });

    test('LayaDriverOptions from the real package is accepted by the registry options type', () => {
        const options = { core: 'mlx-python', modelId: 'm' } as LayaDriverOptions;
        const accepted: LayaLocalDriverOptions = options;
        expect(accepted.core).toBe('mlx-python');
        expect(accepted.modelId).toBe('m');
    });

    test('the hub falls back when resolving laya-local cannot load the package', async () => {
        const registry = new DecisionMakerRegistry({ builtins: false });
        registry.register('typesafe', () =>
            createDecisionMaker({ driver: { name: 'typesafe', ask: () => Promise.reject(new Error('unused')) } }),
        );
        registry.register('laya-local', async () =>
            createDecisionMaker({ driver: await resolveBundledLayaDriver({}, missingPackage) }),
        );
        const hub = new DecisionHub({ registry, now: () => 0 });
        hub.load(await parseDecisionCatalog(CATALOG, 'laya-missing.yaml'));

        const result = await hub.decide('pick', { instructions: 'route this' });
        expect(result).toMatchObject({
            id: 'pick',
            type: 'choice',
            value: 'a',
            confidence: null,
            source: 'default',
            reason: 'no-backend',
            maker: 'laya-local',
        });
        expect(result.error?.name).toBe('DecisionConfigError');
        expect(result.error?.message).toContain('@gobing-ai/ts-laya-mlx');
        expect(result.error?.message).toContain('macOS');
    });

    test('registering the built-in does not load the driver, and maker env is forwarded', async () => {
        const client = {
            ask: () => Promise.reject(new Error('laya stub must not be asked')),
            dispose: () => undefined,
        } as unknown as LayaWorkerClient;
        const registry = new DecisionMakerRegistry({
            builtins: {
                makerOptions: { env: { LAYA_MODEL_ID: 'from-maker' } },
                driverOptions: { 'laya-local': { client } },
            },
        });
        expect(registry.names()).toContain('laya-local');
        const maker = await registry.resolve('laya-local');
        expect(maker.driver).toBe('laya-local');
        expect(await registry.resolve('laya-local')).toBe(maker);
    });

    // On macOS the real driver passes the platform check and would spawn a worker.
    test.skipIf(process.platform === 'darwin')(
        'the real laya-local built-in falls back on a non-macOS host',
        async () => {
            const registry = new DecisionMakerRegistry();
            const hub = new DecisionHub({ registry, now: () => 0 });
            hub.load(await parseDecisionCatalog(CATALOG, 'laya-host.yaml'));

            const result = await hub.decide('pick', { instructions: 'route this' });
            expect(result.source).toBe('default');
            expect(result.reason).toBe('no-backend');
            expect(result.value).toBe('a');
            expect(result.maker).toBe('laya-local');
            expect(result.error?.name).toBe('DecisionConfigError');
            expect(result.error?.message).toContain('darwin arm64');
        },
    );
});
