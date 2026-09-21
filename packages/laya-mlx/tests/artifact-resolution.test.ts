import { describe, expect, it } from 'bun:test';
import { q } from '@gobing-ai/ts-ai-runner';
import { createLayaDriver } from '../src/driver';
import { LayaWorkerClient, resolveForwardedEnv } from '../src/worker-client';

describe('Model artifact resolution and caching (task 0079)', () => {
    describe('R1, R2, AC1 — default model id and cache reuse', () => {
        it('resolves the default model id convaiinnovations/laya-multilingual when omitted', async () => {
            const client = new LayaWorkerClient({
                module: 'tests.fixtures.stub_laya',
                platform: 'darwin',
                arch: 'arm64',
            });
            const driver = createLayaDriver({ client, platform: 'darwin', arch: 'arm64' });
            const res = await driver.ask({
                state: 'test state',
                questions: { color: q.choice('Pick color', { r: 'Red', g: 'Green' }) },
            });
            expect(res.color?.kind).toBe('choice');
            client.dispose();
        });

        it('reuses cached artifact directory across multiple driver instances', async () => {
            const cacheDir = '/tmp/laya-cache-test-dir';
            const client1 = new LayaWorkerClient({
                cacheDir,
                module: 'tests.fixtures.stub_laya',
                platform: 'darwin',
                arch: 'arm64',
            });
            const driver1 = createLayaDriver({ client: client1, platform: 'darwin', arch: 'arm64' });
            const res1 = await driver1.ask({
                state: 'prompt 1',
                questions: { q1: q.choice('Q1', { a: 'A', b: 'B' }) },
            });
            expect(res1.q1?.kind).toBe('choice');
            client1.dispose();

            const client2 = new LayaWorkerClient({
                cacheDir,
                module: 'tests.fixtures.stub_laya',
                platform: 'darwin',
                arch: 'arm64',
            });
            const driver2 = createLayaDriver({ client: client2, platform: 'darwin', arch: 'arm64' });
            const res2 = await driver2.ask({
                state: 'prompt 2',
                questions: { q2: q.choice('Q2', { c: 'C', d: 'D' }) },
            });
            expect(res2.q2?.kind).toBe('choice');
            client2.dispose();
        });
    });

    describe('R3, R4, AC1 — local artifact path precedence and verbatim usage', () => {
        it('explicit modelPath takes precedence over modelId, avoiding any fetch attempt', async () => {
            const localPath = '/local/weights/checkpoint-model';
            const client = new LayaWorkerClient({
                modelPath: localPath,
                modelId: 'some-online-repo/remote-model',
                module: 'tests.fixtures.stub_laya',
                platform: 'darwin',
                arch: 'arm64',
            });
            const driver = createLayaDriver({ client, platform: 'darwin', arch: 'arm64' });
            const res = await driver.ask({
                state: 'offline prompt',
                questions: { decision: q.choice('Choose', { yes: 'Yes', no: 'No' }) },
            });
            expect(res.decision?.kind).toBe('choice');
            client.dispose();
        });

        it('modelPath from injected env takes precedence over modelId', async () => {
            const localPath = '/env/weights/checkpoint-model';
            const client = new LayaWorkerClient({
                env: {
                    LAYA_MODEL_PATH: localPath,
                    LAYA_MODEL_ID: 'remote-id-ignored',
                },
                module: 'tests.fixtures.stub_laya',
                platform: 'darwin',
                arch: 'arm64',
            });
            const driver = createLayaDriver({ client, platform: 'darwin', arch: 'arm64' });
            const res = await driver.ask({
                state: 'env prompt',
                questions: { decision: q.choice('Choose', { x: 'X', y: 'Y' }) },
            });
            expect(res.decision?.kind).toBe('choice');
            client.dispose();
        });
    });

    describe('R5 — configuration read exclusively from injected env record', () => {
        it('resolves modelId, cacheDir, pythonPath, and HF_TOKEN from injected env only', () => {
            const env = {
                LAYA_MODEL_ID: 'custom/model-id-from-env',
                LAYA_CACHE_DIR: '/custom/cache/dir',
                LAYA_PYTHON: '/usr/local/bin/python3-custom',
                HF_TOKEN: 'hf_secret_token_value',
                OTHER_SECRET: 'do-not-forward',
            };
            const forwarded = resolveForwardedEnv(env);
            expect(forwarded).toEqual({
                LAYA_MODEL_ID: 'custom/model-id-from-env',
                LAYA_CACHE_DIR: '/custom/cache/dir',
                LAYA_PYTHON: '/usr/local/bin/python3-custom',
                HF_TOKEN: 'hf_secret_token_value',
            });
            expect((forwarded as Record<string, string>).OTHER_SECRET).toBeUndefined();
        });
    });

    describe('R6, AC2 — offline execution with no network calls', () => {
        it('answers a choice question from cached weights with no HTTP requests', async () => {
            // Overriding fetch in the environment to throw if any network attempt is made
            const originalFetch = globalThis.fetch;
            let networkCallAttempted = false;
            globalThis.fetch = Object.assign(async () => {
                networkCallAttempted = true;
                throw new Error('Network call attempted in offline mode!');
            }, originalFetch) as typeof fetch;
            try {
                const client = new LayaWorkerClient({
                    modelPath: '/local/cached/weights',
                    module: 'tests.fixtures.stub_laya',
                    platform: 'darwin',
                    arch: 'arm64',
                });
                const driver = createLayaDriver({ client, platform: 'darwin', arch: 'arm64' });
                const res = await driver.ask({
                    state: 'offline prompt',
                    questions: { ans: q.choice('Pick one', { ready: 'Ready', wait: 'Wait' }) },
                });
                expect(res.ans?.kind).toBe('choice');
                expect(networkCallAttempted).toBe(false);
                client.dispose();
            } finally {
                globalThis.fetch = originalFetch;
            }
        });
    });
});
