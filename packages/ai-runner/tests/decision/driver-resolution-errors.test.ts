import { describe, expect, it } from 'bun:test';
import type { DecisionMakerOptions } from '../../src';
import { createDecisionMaker, DecisionConfigError, resolveFmDriver, resolveLayaDriver } from '../../src';

/**
 * Task 0086 R9: the import/construction split in driver resolution. Errors
 * thrown BY the driver factory must propagate unchanged so callers see the
 * real cause (e.g. a bad option), not the misleading "requires the package to
 * be installed" message. The import-failure mapping itself is behavior-
 * preserving and noted below.
 */
describe('driver resolution import/construction error split (task 0086 R9)', () => {
    it('construction errors from createFmDriver propagate unchanged (no install hint)', async () => {
        // platform/arch gating inside createFmDriver is a construction error.
        const dm = createDecisionMaker({ backend: 'fm-local', platform: 'linux', arch: 'arm64' });
        const err = await dm.choice('s', 'Pick', { a: 'A', b: 'B' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DecisionConfigError);
        expect((err as DecisionConfigError).variable).toBe('PLATFORM');
        expect((err as Error).message).toContain('darwin arm64');
        expect((err as Error).message).not.toContain('install');
        expect((err as Error).message).not.toContain('bun add');
    });

    // Task 0086 R9: the import-failure branches cannot fire in-workspace (workspace
    // links always resolve and Bun's mock.module does not override already-loaded
    // modules), so the resolvers accept an injectable `importModule` and the branch
    // tests below drive them directly.
    const failingImport = async (): Promise<never> => {
        throw new Error('Cannot find module');
    };
    const resolverOptions: DecisionMakerOptions = { platform: 'darwin', arch: 'arm64' };

    it('laya import failure maps to the install-hint DecisionConfigError', async () => {
        const err = await resolveLayaDriver(resolverOptions, failingImport).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DecisionConfigError);
        expect((err as DecisionConfigError).variable).toBe('LAYA_BACKEND');
        expect((err as Error).message).toContain("requires '@gobing-ai/ts-laya-mlx' to be installed");
        expect((err as Error).message).toContain('bun add @gobing-ai/ts-laya-mlx');
        expect((err as { cause?: unknown }).cause).toBeInstanceOf(Error);
    });

    it('laya module without createLayaDriver export maps to DecisionConfigError (not factory call)', async () => {
        const err = await resolveLayaDriver(resolverOptions, async () => ({})).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DecisionConfigError);
        expect((err as Error).message).toContain("Module '@gobing-ai/ts-laya-mlx' does not export createLayaDriver");
    });

    it('fm import failure maps to the install-hint DecisionConfigError', async () => {
        const err = await resolveFmDriver(resolverOptions, failingImport).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DecisionConfigError);
        expect((err as DecisionConfigError).variable).toBe('FM_BACKEND');
        expect((err as Error).message).toContain("requires '@gobing-ai/ts-decision-fm' to be installed");
        expect((err as Error).message).toContain('bun add @gobing-ai/ts-decision-fm');
        expect((err as { cause?: unknown }).cause).toBeInstanceOf(Error);
    });

    it('fm module without createFmDriver export maps to DecisionConfigError (not factory call)', async () => {
        const err = await resolveFmDriver(resolverOptions, async () => ({})).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DecisionConfigError);
        expect((err as Error).message).toContain("Module '@gobing-ai/ts-decision-fm' does not export createFmDriver");
    });

    it('laya construction errors propagate unchanged (mirror of fm)', async () => {
        const dm = createDecisionMaker({
            backend: 'laya-local',
            module: 'no.such.python.module',
            platform: 'darwin',
            arch: 'arm64',
        });
        const err = await dm.choice('s', 'Pick', { a: 'A', b: 'B' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        // The real module-loading failure text must survive, not be rewritten to install hint.
        expect((err as Error).message).not.toContain("The 'laya-local' backend requires");
    });
});
