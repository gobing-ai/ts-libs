import { describe, expect, test } from 'bun:test';
import type { BusLifecycleEvents } from '@gobing-ai/ts-infra';
import { EventBus, setLoggerMuted } from '@gobing-ai/ts-infra';
import { runApplication } from '@gobing-ai/ts-infra/application';
import { RuleEngine } from '../src/engine';
import type { RuleEngineEvents } from '../src/events';
import { RuleEngineHost } from '../src/host/rule-engine-host';
import type { ConstraintRule } from '../src/types';

setLoggerMuted(true);

function hostWithPassEvaluator(): RuleEngineHost {
    const host = new RuleEngineHost();
    host.evaluators.register(
        'pass',
        {
            async evaluate() {
                return { findings: [], fixes: [] };
            },
        },
        'extension',
    );
    return host;
}

const rule = (id: string): ConstraintRule => ({
    id,
    description: id,
    enabled: true,
    severity: 'error',
    evaluator: { type: 'pass' },
});

/**
 * R2: RuleEngine constructs an internal EventBus parented to the supplied
 * lifecycleBus when `events` is omitted. `rule.*` emits must propagate to the
 * lifecycle bus as `bus.emit.done` System Events.
 */
describe('RuleEngine — lifecycle bus propagation (R2)', () => {
    test('rule.run.start reaches the parent lifecycle bus', async () => {
        const seen: string[] = [];
        const lifecycleBus = new EventBus<BusLifecycleEvents>();
        lifecycleBus.on('bus.emit.done', (d) => seen.push(d.event));
        const events = new EventBus<RuleEngineEvents>({ lifecycleBus });

        const engine = new RuleEngine({ events, lifecycleBus, host: hostWithPassEvaluator() });

        await engine.evaluate([rule('r2-trivial')], process.cwd());

        expect(seen).toContain('rule.run.start');
        expect(seen).toContain('rule.run.done');
    });

    test('a downstream RuleEngine writes through the bootstrap lifecycle bus', async () => {
        const recorded: string[] = [];
        const app = await runApplication({
            services: {
                fileObserverWriter: {
                    ensureDir() {},
                    appendFile(_path, content) {
                        recorded.push(content);
                    },
                },
            },
            start() {},
        });
        const engine = new RuleEngine({ lifecycleBus: app.lifecycleBus, host: hostWithPassEvaluator() });

        await engine.evaluate([rule('r6-shared-writer')], process.cwd());

        const events = recorded.map((line) => JSON.parse(line).event);
        expect(events).toContain('rule.run.start');
        expect(events).toContain('rule.run.done');
        await app.stop();
    });

    test('explicit events bus is used as-is — no parent propagation', async () => {
        const seen: string[] = [];
        const ownBus = new EventBus<RuleEngineEvents>();
        ownBus.on('rule.run.start', () => seen.push('own'));

        const engine = new RuleEngine({ events: ownBus, host: hostWithPassEvaluator() });

        await engine.evaluate([rule('r2-own')], process.cwd());
        expect(seen).toContain('own');
    });
});
