/**
 * The default native loader seam — `LayaNativeClient` constructed with no injected
 * loader. Core routing, option rejection, load-failure mapping and disposal are
 * pinned by core-selection.test.ts; this file covers the one path those tests
 * cannot reach: the lazy `@johnhenry/laya` import itself. `load` is spied on the
 * module namespace (never `mock.module`, which is process-global) so the unit lane
 * loads no libmlxc and no checkpoint.
 */
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as laya from '@johnhenry/laya';
import { LayaNativeClient } from '../src/native-client';
import { DEFAULT_LAYA_MODEL_ID } from '../src/worker-client';

const agent = {
    predict: async () => ({ answers: {} }),
    dispose: () => {},
};

afterEach(() => {
    mock.restore();
});

describe('default native loader', () => {
    it('lazily imports @johnhenry/laya and forwards the resolved checkpoint and load options', async () => {
        const load = spyOn(laya, 'load').mockResolvedValue(agent as never);
        const client = new LayaNativeClient({ platform: 'darwin', arch: 'arm64', env: {}, batchSize: 4 });

        await client.warm();

        expect(load).toHaveBeenCalledTimes(1);
        expect(load.mock.calls[0]?.[0]).toBe(DEFAULT_LAYA_MODEL_ID);
        expect(load.mock.calls[0]?.[1]).toMatchObject({ backend: 'mlx', dtype: 'f16', batchSize: 4 });
        client.dispose();
    });
});
