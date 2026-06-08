import { describe, expect, test } from 'bun:test';
import { PluginHost } from '../../../src/application/plugins/host';
import type { Plugin } from '../../../src/application/plugins/types';
import type { EventBus } from '../../../src/event-bus/event-bus';
import { EventBus as EventBusImpl } from '../../../src/event-bus/event-bus';
import type { EventMap } from '../../../src/event-bus/types';

// ── Helpers ───────────────────────────────────────────────────────────────

/** Create a minimal EventBus stub for host unit tests. */
function stubEvents(): EventBus<EventMap> {
    return new EventBusImpl<EventMap>();
}

/** Create a minimal Plugin with configurable hooks. */
function makePlugin(
    name: string,
    hooks?: {
        onLoad?: ((_host: PluginHost) => void | Promise<void>) | null;
        onUnload?: ((_host: PluginHost) => void | Promise<void>) | null;
        onStart?: ((_host: PluginHost) => void | Promise<void>) | null;
        onStop?: ((_host: PluginHost) => void | Promise<void>) | null;
    },
): Plugin {
    return {
        name,
        version: '1.0.0',
        onLoad: (hooks?.onLoad ?? (async () => {})) as Plugin['onLoad'],
        onUnload: (hooks?.onUnload === null ? undefined : hooks?.onUnload) as Plugin['onUnload'],
        onStart: (hooks?.onStart === null ? undefined : hooks?.onStart) as Plugin['onStart'],
        onStop: (hooks?.onStop === null ? undefined : hooks?.onStop) as Plugin['onStop'],
    };
}

// ── Registration ──────────────────────────────────────────────────────────

describe('PluginHost — registration', () => {
    test('register adds plugin and list returns it', () => {
        const host = new PluginHost(stubEvents());
        const p = makePlugin('alpha');
        host.register(p);
        expect(host.has('alpha')).toBe(true);
        expect(host.list()).toEqual([{ name: 'alpha', version: '1.0.0' }]);
    });

    test('register throws on duplicate name', () => {
        const host = new PluginHost(stubEvents());
        host.register(makePlugin('alpha'));
        expect(() => host.register(makePlugin('alpha'))).toThrow('Plugin already registered: alpha');
    });

    test('unregister removes plugin', () => {
        const host = new PluginHost(stubEvents());
        host.register(makePlugin('alpha'));
        host.unregister('alpha');
        expect(host.has('alpha')).toBe(false);
        expect(host.list()).toEqual([]);
    });

    test('unregister of absent name is no-op', () => {
        const host = new PluginHost(stubEvents());
        host.unregister('nope');
        expect(host.has('nope')).toBe(false);
    });

    test('has returns false for unknown name', () => {
        const host = new PluginHost(stubEvents());
        expect(host.has('unknown')).toBe(false);
    });

    test('list preserves insertion order', () => {
        const host = new PluginHost(stubEvents());
        host.register(makePlugin('c'));
        host.register(makePlugin('a'));
        host.register(makePlugin('b'));
        expect(host.list().map((s) => s.name)).toEqual(['c', 'a', 'b']);
    });
});

// ── Lifecycle — loadAll (fail-fast) ───────────────────────────────────────

describe('PluginHost — loadAll (fail-fast)', () => {
    test('calls onLoad on every plugin in registration order', async () => {
        const host = new PluginHost(stubEvents());
        const order: string[] = [];
        host.register(makePlugin('first', { onLoad: () => void order.push('first') }));
        host.register(makePlugin('second', { onLoad: () => void order.push('second') }));

        await host.loadAll();
        expect(order).toEqual(['first', 'second']);
    });

    test('rethrows on first onLoad failure and aborts', async () => {
        const host = new PluginHost(stubEvents());
        const order: string[] = [];
        host.register(
            makePlugin('good', {
                onLoad: () => void order.push('good'),
            }),
        );
        host.register(
            makePlugin('bad', {
                onLoad: () => {
                    throw new Error('load-fail');
                },
            }),
        );
        host.register(
            makePlugin('after', {
                onLoad: () => void order.push('after'),
            }),
        );

        await expect(host.loadAll()).rejects.toThrow('load-fail');
        // 'good' was loaded; 'bad' threw; 'after' was never reached
        expect(order).toEqual(['good']);
    });
});

// ── Lifecycle — startAll (fail-soft) ──────────────────────────────────────

describe('PluginHost — startAll (fail-soft)', () => {
    test('calls onStart on every plugin in registration order', async () => {
        const host = new PluginHost(stubEvents());
        const order: string[] = [];
        host.register(makePlugin('first', { onStart: () => void order.push('first') }));
        host.register(makePlugin('second', { onStart: () => void order.push('second') }));

        await host.startAll();
        expect(order).toEqual(['first', 'second']);
    });

    test('skips plugin without onStart', async () => {
        const host = new PluginHost(stubEvents());
        const order: string[] = [];
        host.register(makePlugin('a', { onStart: () => void order.push('a') }));
        host.register(makePlugin('b', { onStart: null })); // no onStart
        host.register(makePlugin('c', { onStart: () => void order.push('c') }));

        await host.startAll();
        expect(order).toEqual(['a', 'c']);
    });

    test('logs error and continues when onStart throws', async () => {
        const host = new PluginHost(stubEvents());
        const order: string[] = [];
        host.register(
            makePlugin('good', {
                onStart: () => void order.push('good'),
            }),
        );
        host.register(
            makePlugin('bad', {
                onStart: () => {
                    throw new Error('start-fail');
                },
            }),
        );
        host.register(
            makePlugin('after', {
                onStart: () => void order.push('after'),
            }),
        );

        // startAll should not throw
        await host.startAll();
        expect(order).toEqual(['good', 'after']);
    });
});

// ── Lifecycle — stopAll (fail-soft, reverse order) ────────────────────────

describe('PluginHost — stopAll (fail-soft, reverse order)', () => {
    test('calls onStop in reverse registration order', async () => {
        const host = new PluginHost(stubEvents());
        const order: string[] = [];
        host.register(makePlugin('first', { onStop: () => void order.push('first') }));
        host.register(makePlugin('second', { onStop: () => void order.push('second') }));

        await host.stopAll();
        // reverse: second → first
        expect(order).toEqual(['second', 'first']);
    });

    test('skips plugin without onStop', async () => {
        const host = new PluginHost(stubEvents());
        const order: string[] = [];
        host.register(makePlugin('a', { onStop: () => void order.push('a') }));
        host.register(makePlugin('b', { onStop: null }));
        host.register(makePlugin('c', { onStop: () => void order.push('c') }));

        await host.stopAll();
        // reverse: c → a (b skipped)
        expect(order).toEqual(['c', 'a']);
    });

    test('logs error and continues when onStop throws', async () => {
        const host = new PluginHost(stubEvents());
        const order: string[] = [];
        host.register(
            makePlugin('good', {
                onStop: () => void order.push('good'),
            }),
        );
        host.register(
            makePlugin('bad', {
                onStop: () => {
                    throw new Error('stop-fail');
                },
            }),
        );

        // stopAll should not throw
        await host.stopAll();
        expect(order).toEqual(['good']); // bad is tried first in reverse then good
    });
});

// ── Lifecycle — unloadAll (fail-soft, reverse order) ──────────────────────

describe('PluginHost — unloadAll (fail-soft, reverse order)', () => {
    test('calls onUnload in reverse registration order', async () => {
        const host = new PluginHost(stubEvents());
        const order: string[] = [];
        host.register(makePlugin('first', { onUnload: () => void order.push('first') }));
        host.register(makePlugin('second', { onUnload: () => void order.push('second') }));

        await host.unloadAll();
        expect(order).toEqual(['second', 'first']);
    });

    test('logs error and continues when onUnload throws', async () => {
        const host = new PluginHost(stubEvents());
        const order: string[] = [];
        host.register(
            makePlugin('bad', {
                onUnload: () => {
                    throw new Error('unload-fail');
                },
            }),
        );
        host.register(
            makePlugin('good', {
                onUnload: () => void order.push('good'),
            }),
        );

        await host.unloadAll();
        expect(order).toEqual(['good']);
    });
});
