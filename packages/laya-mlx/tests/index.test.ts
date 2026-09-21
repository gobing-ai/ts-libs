import { describe, expect, it } from 'bun:test';

/**
 * Scaffold-level guard: the placeholder entry point must stay importable as a
 * module so build, typecheck, and dist smoke-import keep covering this package
 * before the real surface lands.
 */
describe('@gobing-ai/ts-laya-mlx scaffold', () => {
    it('exposes an importable entry module', async () => {
        const mod = await import('../src/index');
        expect(mod).toBeTypeOf('object');
    });
});
