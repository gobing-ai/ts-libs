import { describe, expect, it } from 'bun:test';
import {
    DecisionBackendError,
    DecisionConfigError,
    DecisionRequestError,
    DecisionTimeoutError,
} from '@gobing-ai/ts-ai-runner';
import { getProcessEnv } from '@gobing-ai/ts-runtime';
import {
    LayaWorkerClient,
    type LayaWorkerResult,
    resolveForwardedEnv,
    type WorkerQuestion,
} from '../src/worker-client';

/**
 * Process-client fixture (task 0076): drives the TypeScript client over the same
 * stub runtime module as the protocol fixture, so lazy start, handshake budget,
 * id correlation, timeout budgets, env allowlisting, and death-mid-ask recovery
 * are covered in the default lane — no interpreter environment, no checkpoint.
 * The stub's deterministic hooks (stub/slow-start, 'slow', 'die', the parent-env
 * sentinel, and the usage pid) make every branch observable without real MLX.
 */

const STUB_MODULE = 'tests.fixtures.stub_laya';

type ClientOptions = ConstructorParameters<typeof LayaWorkerClient>[0];

function makeClient(overrides: Partial<ClientOptions> = {}): LayaWorkerClient {
    return new LayaWorkerClient({ module: STUB_MODULE, ...overrides });
}

function q(instructions: string, extra: Record<string, unknown> = {}): WorkerQuestion {
    return { type: 'noul', instructions, ...extra };
}

function pidOf(result: LayaWorkerResult): number {
    const usage = result.usage as { pid?: number } | undefined;
    if (usage?.pid === undefined) throw new Error('stub usage carried no pid');
    return usage.pid;
}

describe('LayaWorkerClient lifecycle', () => {
    it('pays the spawn once: repeated asks reuse the same warm worker', async () => {
        const client = makeClient();
        const first = await client.ask('state text', { a: q('fine') });
        const second = await client.ask('state text', { b: q('fine') });
        expect(Object.keys(first.answers)).toEqual(['a']);
        expect(Object.keys(second.answers)).toEqual(['b']);
        expect(pidOf(second)).toBe(pidOf(first));
        client.dispose();
    });

    it('rejects the first ask when the handshake exceeds startupTimeoutMs and respawns fresh afterwards', async () => {
        const client = makeClient({ modelId: 'stub/slow-start', startupTimeoutMs: 200 });
        const error = await client.ask('s', { a: q('fine') }).then(
            () => {
                throw new Error('expected the handshake budget to reject');
            },
            (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(DecisionTimeoutError);
        expect((error as DecisionTimeoutError).timeoutMs).toBe(200);
        // The dead handle is not reused: the next ask starts a fresh worker and
        // hits the same budget, proving no poisoned reuse.
        await expect(client.ask('s', { a: q('fine') })).rejects.toBeInstanceOf(DecisionTimeoutError);
    });

    it('maps a startup config rejection onto DecisionConfigError and starts fresh on the next ask', async () => {
        // 'float8' is deliberately invalid: the runtime constructor rejects it and
        // the worker reports the failure through the structured config handshake.
        const client = makeClient({ dtype: 'float8' as 'float16' });
        await expect(client.ask('s', { a: q('fine') })).rejects.toBeInstanceOf(DecisionConfigError);
        await expect(client.ask('s', { a: q('fine') })).rejects.toBeInstanceOf(DecisionConfigError);
    });

    it('routes worker request errors to the right caller by id and keeps the worker serving', async () => {
        const client = makeClient();
        await expect(
            client.ask('s', { bad: { type: 'quantum', instructions: 'x' } as unknown as WorkerQuestion }),
        ).rejects.toBeInstanceOf(DecisionRequestError);
        const after = await client.ask('s', { good: q('fine') });
        expect(after.model).toBe('stub-laya');
        expect(Object.keys(after.answers)).toEqual(['good']);
        client.dispose();
    });

    it('rejects a request that exceeds requestTimeoutMs without corrupting the stream', async () => {
        const client = makeClient({ requestTimeoutMs: 100 });
        await expect(client.ask('s', { slow: q('slow', { delaySeconds: 1 }) })).rejects.toBeInstanceOf(
            DecisionTimeoutError,
        );
        // The worker stays up (R4): let it drain the stale forward pass, then prove
        // the same worker still serves the next ask and the late response for the
        // timed-out id was dropped by correlation rather than misrouted.
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const after = await client.ask('s', { fine: q('fine') });
        expect(Object.keys(after.answers)).toEqual(['fine']);
        client.dispose();
    });

    it('rejects the in-flight ask when the worker dies mid-request and respawns on the next ask', async () => {
        const client = makeClient();
        const warm = await client.ask('s', { warm: q('fine') });
        const originalPid = pidOf(warm);
        const error = await client.ask('s', { die: q('die') }).then(
            () => {
                throw new Error('expected the in-flight ask to reject');
            },
            (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(DecisionBackendError);
        expect((error as Error).message).toContain('code 7');
        const fresh = await client.ask('s', { again: q('fine') });
        expect(Object.keys(fresh.answers)).toEqual(['again']);
        expect(pidOf(fresh)).not.toBe(originalPid);
        client.dispose();
    });

    it('forwards only documented env keys: the parent environment is not inherited wholesale', async () => {
        const ambient = getProcessEnv();
        ambient.LAYA_PARENT_SENTINEL = 'leak-probe';
        try {
            // The accessor must hand back the live environment record, not a copy —
            // otherwise the sentinel would never reach the spawn boundary and the
            // probe below would be vacuous.
            expect(ambient.LAYA_PARENT_SENTINEL).toBe('leak-probe');
            // The stub fails construction if the sentinel crosses the boundary,
            // so a successful ask proves the child env is the allowlist, not $ENV.
            const client = makeClient({ env: { HF_TOKEN: 'tok-123', UNDOCUMENTED_KEY: 'dropped' } });
            const result = await client.ask('s', { a: q('fine') });
            expect(result.model).toBe('stub-laya');
        } finally {
            delete ambient.LAYA_PARENT_SENTINEL;
        }
        expect(resolveForwardedEnv(undefined)).toEqual({});
        expect(resolveForwardedEnv({ HF_TOKEN: 'tok', PATH: '/usr/bin', LAYA_CACHE_DIR: '/tmp/c' })).toEqual({
            HF_TOKEN: 'tok',
            LAYA_CACHE_DIR: '/tmp/c',
        });
    });

    it('disposes repeatedly and rejects asks after disposal', async () => {
        const client = makeClient();
        await client.ask('s', { a: q('fine') });
        client.dispose();
        client.dispose();
        await expect(client.ask('s', { b: q('fine') })).rejects.toThrow(/disposed/);
    });
});
