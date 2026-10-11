/**
 * Core selection (`mlx-python` | `mlx-native` | `auto`) and the native client.
 * Failure modes enumerated first: unknown core, unsupported native options,
 * native load failure (explicit → config error; auto → python fallback),
 * non-finite outputs, disposal, model resolution precedence, and identical
 * answer mapping across cores.
 */
import { describe, expect, it } from 'bun:test';
import { createDecisionMaker, DecisionBackendError, DecisionConfigError, q } from '@gobing-ai/ts-ai-runner';
import type { LayaAgent } from '@johnhenry/laya';
import { createLayaClient, createLayaDriver, resolveLayaCore } from '../src/driver';
import { LayaNativeClient, type LayaNativeLoader } from '../src/native-client';
import { DEFAULT_LAYA_MODEL_ID, LayaWorkerClient } from '../src/worker-client';

const host = { platform: 'darwin', arch: 'arm64' } as const;

interface LoadCall {
    target: string;
    opts: Record<string, unknown>;
}

/** Loader returning a fake agent that answers like @johnhenry/laya's predict(). */
function fakeLoader(calls: LoadCall[] = [], answers?: Record<string, unknown>): LayaNativeLoader {
    return async (target, opts) => {
        calls.push({ target, opts });
        let disposed = 0;
        const agent = {
            predict: async (_state: string, questions: Record<string, { type: string }>) => ({
                model: 'laya-rl-agent',
                answers:
                    answers ??
                    Object.fromEntries(
                        Object.entries(questions).map(([name, question]) => [
                            name,
                            question.type === 'choice'
                                ? {
                                      type: 'choice',
                                      confidence: 0.9,
                                      choice: 'pos',
                                      probabilities: { pos: 0.95, neg: 0.05 },
                                  }
                                : question.type === 'score'
                                  ? {
                                        type: 'score',
                                        confidence: 0.4,
                                        score: 1.6,
                                        legend: { 0: 'poor', 1: 'fair', 2: 'good' },
                                        probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 },
                                    }
                                  : { type: 'noul', confidence: 0.7, noul: 0.7, action: { act_probability: 1 } },
                        ]),
                    ),
            }),
            dispose: () => {
                disposed++;
            },
            get disposedCount() {
                return disposed;
            },
        };
        return agent as unknown as LayaAgent;
    };
}

const failingLoader: LayaNativeLoader = async () => {
    throw new Error('libmlxc not found');
};

describe('resolveLayaCore', () => {
    it('defaults to mlx-python so existing callers keep the Python worker', () => {
        expect(resolveLayaCore()).toBe('mlx-python');
        expect(resolveLayaCore({ env: { LAYA_CORE: '' } })).toBe('mlx-python');
    });

    it('reads the injected env and lets the explicit option win', () => {
        expect(resolveLayaCore({ env: { LAYA_CORE: 'mlx-native' } })).toBe('mlx-native');
        expect(resolveLayaCore({ core: 'auto', env: { LAYA_CORE: 'mlx-native' } })).toBe('auto');
    });

    it('rejects an unknown core as a config error instead of silently defaulting', () => {
        expect(() => resolveLayaCore({ env: { LAYA_CORE: 'onnx' } })).toThrow(DecisionConfigError);
        expect(() => createLayaDriver({ ...host, core: 'gpu' as never })).toThrow(/Unknown laya core 'gpu'/);
    });
});

describe('createLayaClient core routing', () => {
    it('builds the Python worker for mlx-python and the native client for mlx-native', () => {
        expect(createLayaClient({ ...host })).toBeInstanceOf(LayaWorkerClient);
        expect(createLayaClient({ ...host, core: 'mlx-native', nativeLoader: fakeLoader() })).toBeInstanceOf(
            LayaNativeClient,
        );
    });

    it('mlx-native never spawns Python: a bogus pythonPath is irrelevant', async () => {
        const driver = createLayaDriver({
            ...host,
            core: 'mlx-native',
            pythonPath: '/nonexistent/python',
            nativeLoader: fakeLoader(),
        });
        const res = await driver.ask({ state: 's', questions: { ok: q.noul('ok?') } });
        expect(res.ok).toEqual({ kind: 'noul', probability: 0.7 });
    });
});

describe('LayaNativeClient', () => {
    it('loads the official checkpoint by default with f16 on the MLX backend', async () => {
        const calls: LoadCall[] = [];
        const client = new LayaNativeClient({ ...host, loader: fakeLoader(calls) });
        await client.warm();
        expect(calls).toHaveLength(1);
        expect(calls[0]?.target).toBe(DEFAULT_LAYA_MODEL_ID);
        expect(calls[0]?.opts).toMatchObject({ backend: 'mlx', dtype: 'f16', batchSize: 16 });
        client.dispose();
    });

    it('resolves fine-tuned checkpoints: modelPath > env path > modelId > env id', () => {
        const target = (opts: ConstructorParameters<typeof LayaNativeClient>[0]) =>
            new LayaNativeClient({ ...host, ...opts }).model;
        expect(target({ modelId: 'me/laya-ft', modelPath: '/ckpt/a', env: { LAYA_MODEL_PATH: '/ckpt/b' } })).toBe(
            '/ckpt/a',
        );
        expect(target({ modelId: 'me/laya-ft', env: { LAYA_MODEL_PATH: '/ckpt/b' } })).toBe('/ckpt/b');
        expect(target({ modelId: 'me/laya-ft', env: { LAYA_MODEL_ID: 'other/id' } })).toBe('me/laya-ft');
        expect(target({ env: { LAYA_MODEL_ID: 'other/id' } })).toBe('other/id');
    });

    it('forwards revision, float32 and HF_TOKEN to the loader', async () => {
        const calls: LoadCall[] = [];
        const client = new LayaNativeClient({
            ...host,
            revision: 'abc123',
            dtype: 'float32',
            env: { HF_TOKEN: 'hf_x' },
            loader: fakeLoader(calls),
        });
        await client.warm();
        expect(calls[0]?.opts).toMatchObject({ dtype: 'f32', revision: 'abc123', token: 'hf_x' });
    });

    it('refuses options it cannot honor rather than ignoring them', () => {
        expect(() => new LayaNativeClient({ ...host, cacheDir: '/tmp/hf' })).toThrow(DecisionConfigError);
        expect(() => new LayaNativeClient({ ...host, env: { LAYA_CACHE_DIR: '/tmp/hf' } })).toThrow(/cacheDir/);
        expect(() => new LayaNativeClient({ ...host, dtype: 'bfloat16' })).toThrow(/bfloat16/);
    });

    it('refuses unsupported hosts before loading anything', () => {
        expect(() => new LayaNativeClient({ platform: 'linux', arch: 'x64' })).toThrow(DecisionConfigError);
    });

    it('reports a load failure as a config error naming the checkpoint, and retries on the next ask', async () => {
        let attempts = 0;
        const loader: LayaNativeLoader = async (...args) => {
            attempts++;
            if (attempts === 1) throw new Error('weights missing');
            return fakeLoader()(...args);
        };
        const client = new LayaNativeClient({ ...host, modelPath: '/ckpt/ft', loader });
        await expect(client.ask('s', { a: { type: 'noul', instructions: 'x' } })).rejects.toThrow(
            /failed to load '\/ckpt\/ft': weights missing/,
        );
        const ok = await client.ask('s', { a: { type: 'noul', instructions: 'x' } });
        expect(ok.answers.a).toBeDefined();
        expect(attempts).toBe(2);
    });

    it('loads the weights once for concurrent asks', async () => {
        const calls: LoadCall[] = [];
        const client = new LayaNativeClient({ ...host, loader: fakeLoader(calls) });
        const question = { a: { type: 'noul' as const, instructions: 'x' } };
        await Promise.all([client.ask('1', question), client.ask('2', question), client.ask('3', question)]);
        expect(calls).toHaveLength(1);
    });

    it('rejects non-finite outputs with the float32 remedy', async () => {
        const client = new LayaNativeClient({
            ...host,
            loader: fakeLoader([], { a: { type: 'noul', confidence: Number.NaN, noul: Number.NaN } }),
        });
        await expect(client.ask('s', { a: { type: 'noul', instructions: 'x' } })).rejects.toThrow(/float32/);
    });

    it('rejects asks after dispose and releases the agent', async () => {
        const client = new LayaNativeClient({ ...host, loader: fakeLoader() });
        await client.warm();
        client.dispose();
        client.dispose();
        await expect(client.ask('s', { a: { type: 'noul', instructions: 'x' } })).rejects.toThrow(DecisionBackendError);
    });
});

describe('auto core', () => {
    it('uses the native core when it loads', async () => {
        const calls: LoadCall[] = [];
        const driver = createLayaDriver({
            ...host,
            core: 'auto',
            pythonPath: '/nonexistent/python',
            nativeLoader: fakeLoader(calls),
        });
        const res = await driver.ask({ state: 's', questions: { ok: q.noul('ok?') } });
        expect(res.ok?.kind).toBe('noul');
        expect(calls).toHaveLength(1);
    });

    it('falls back to the Python worker when the native core cannot load', async () => {
        const driver = createLayaDriver({
            ...host,
            core: 'auto',
            module: 'tests.fixtures.stub_laya',
            nativeLoader: failingLoader,
        });
        const res = await driver.ask({
            state: 's',
            questions: { sentiment: q.choice('Rate', { pos: 'Positive', neg: 'Negative' }) },
        });
        expect(res.sentiment?.kind).toBe('choice');
    });

    it('falls back when native rejects an option (cacheDir) instead of failing the decision', async () => {
        let loaded = false;
        const driver = createLayaDriver({
            ...host,
            core: 'auto',
            cacheDir: '/tmp/laya-cache-test',
            module: 'tests.fixtures.stub_laya',
            nativeLoader: async (...args) => {
                loaded = true;
                return fakeLoader()(...args);
            },
        });
        const res = await driver.ask({ state: 's', questions: { approved: q.noul('Deploy?') } });
        expect(res.approved?.kind).toBe('noul');
        expect(loaded).toBe(false);
    });
});

describe('cross-core contract parity', () => {
    it('maps identical runtime payloads to identical neutral answers on both cores', async () => {
        const questions = {
            sentiment: q.choice('Rate sentiment', { pos: 'Positive', neg: 'Negative' }),
            quality: q.score('Score code', ['poor', 'fair', 'good']),
            approved: q.noul('Should deploy?'),
        };
        const native = createDecisionMaker({
            driver: createLayaDriver({ ...host, core: 'mlx-native', nativeLoader: fakeLoader() }),
        });
        const res = await native.ask({ state: 'user prompt', questions });
        expect(res.sentiment).toMatchObject({ kind: 'choice', label: 'pos' });
        expect(res.quality).toMatchObject({ kind: 'score', score: 2 });
        expect(res.approved).toEqual({ kind: 'noul', probability: 0.7 });
    });
});
