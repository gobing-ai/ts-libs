import { describe, expect, test } from 'bun:test';
import { EventBus, type Logger, setLoggerMuted } from '@gobing-ai/ts-infra';
import { RuleEngine } from '../src/engine';
import type { RuleEngineEvents } from '../src/events';
import { RuleEngineHost } from '../src/host/rule-engine-host';
import type { ConstraintRule } from '../src/types';

setLoggerMuted(true);

const rule = (id: string, evaluator = 'pass'): ConstraintRule => ({
    id,
    description: id,
    enabled: true,
    severity: 'error',
    evaluator: { type: evaluator },
});

function recordingLogger(): { logger: Logger; lines: string[] } {
    const lines: string[] = [];
    const make = (): Logger => ({
        trace: (msg) => lines.push(`trace:${msg}`),
        debug: (msg) => lines.push(`debug:${msg}`),
        info: (msg) => lines.push(`info:${msg}`),
        warn: (msg) => lines.push(`warn:${msg}`),
        error: (msg) => lines.push(`error:${msg}`),
        fatal: (msg) => lines.push(`fatal:${msg}`),
        child: () => make(),
    });
    return { logger: make(), lines };
}

function hostWithEvaluators(): RuleEngineHost {
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
    host.evaluators.register(
        'violate',
        {
            async evaluate(ruleDef) {
                return {
                    findings: [
                        {
                            ruleId: ruleDef.id,
                            severity: ruleDef.severity,
                            message: 'violation',
                            filePath: null,
                            kind: 'violation',
                        },
                    ],
                    fixes: [],
                };
            },
        },
        'extension',
    );
    host.evaluators.register(
        'throw',
        {
            async evaluate() {
                throw new Error('boom');
            },
        },
        'extension',
    );
    return host;
}

describe('RuleEngine', () => {
    test('instantiation creates engine with default host', () => {
        const engine = new RuleEngine();
        expect(engine).toBeInstanceOf(RuleEngine);
        expect(engine.host).toBeDefined();
    });

    test('instantiation accepts custom host option', () => {
        const engine = new RuleEngine({});
        expect(engine.host).toBeDefined();
    });

    test('registerEvaluator adds evaluator to host', () => {
        const engine = new RuleEngine();
        const evaluator = { evaluate: async () => ({ findings: [], fixes: [] }) };
        engine.registerEvaluator('test-eval', evaluator);
        expect(engine.host.evaluators.has('test-eval')).toBe(true);
    });

    test('emits run and per-rule events in evaluation order', async () => {
        const events = new EventBus<RuleEngineEvents>();
        const seen: string[] = [];
        events.on('rule.run.start', (data) => seen.push(`run.start:${data.rules}/${data.total}`));
        events.on('rule.eval.start', (data) => seen.push(`eval.start:${data.ruleId}:${data.index}/${data.total}`));
        events.on('rule.eval.done', (data) => seen.push(`eval.done:${data.ruleId}:${data.findings}`));
        events.on('rule.run.done', (data) => seen.push(`run.done:${data.rules}:${data.findings}:${data.stoppedEarly}`));

        await new RuleEngine({ host: hostWithEvaluators(), events }).evaluate(
            [rule('a'), rule('b'), rule('c')],
            process.cwd(),
        );

        expect(seen).toEqual([
            'run.start:3/3',
            'eval.start:a:1/3',
            'eval.done:a:0',
            'eval.start:b:2/3',
            'eval.done:b:0',
            'eval.start:c:3/3',
            'eval.done:c:0',
            'run.done:3:0:false',
        ]);
    });

    test('marks stoppedEarly when stopOnFirst short-circuits', async () => {
        const events = new EventBus<RuleEngineEvents>();
        const done: Array<Parameters<RuleEngineEvents['rule.run.done']>[0]> = [];
        events.on('rule.run.done', (data) => done.push(data));

        await new RuleEngine({ host: hostWithEvaluators(), events }).evaluate(
            [rule('a', 'violate'), rule('b')],
            process.cwd(),
            'error',
        );

        expect(done).toHaveLength(1);
        expect(done[0]).toMatchObject({ rules: 2, findings: 1, stoppedEarly: true });
    });

    test('emits eval.error only for thrown evaluators and still emits an error finding', async () => {
        const events = new EventBus<RuleEngineEvents>();
        const seen: string[] = [];
        events.on('rule.eval.error', (data) => seen.push(`error:${data.ruleId}:${data.error}`));
        events.on('rule.eval.done', (data) => seen.push(`done:${data.ruleId}:${data.findings}`));

        const result = await new RuleEngine({ host: hostWithEvaluators(), events }).evaluate(
            [rule('violation', 'violate'), rule('thrown', 'throw')],
            process.cwd(),
        );

        expect(seen).toEqual(['done:violation:1', 'error:thrown:boom', 'done:thrown:1']);
        expect(result.findings).toHaveLength(2);
        expect(result.findings[0]?.kind).toBe('violation');
        expect(result.findings[1]).toMatchObject({ ruleId: 'thrown', kind: 'error', code: 'evaluator:throw' });
    });

    test('omitting events still evaluates without subscriber work', async () => {
        const result = await new RuleEngine({ host: hostWithEvaluators() }).evaluate([rule('a')], process.cwd());
        expect(result).toEqual({ findings: [], fixes: [] });
    });

    test('emits run start, per-rule debug, and run done through injected logger', async () => {
        const { logger, lines } = recordingLogger();
        await new RuleEngine({ host: hostWithEvaluators(), logger }).evaluate([rule('a'), rule('b')], process.cwd());

        expect(lines).toContain('info:rule run started');
        expect(lines.filter((line) => line === 'debug:eval start')).toHaveLength(2);
        expect(lines).toContain('info:rule run done');
    });

    test('injected fileSystem reaches evaluators through RuleContext', async () => {
        const readPaths: string[] = [];
        const fakeFs = {
            getProjectRoot: () => '/fake',
            resolve: (...segs: string[]) => `/fake/${segs.join('/')}`,
            exists: (_path: string) => false,
            readFile: (path: string) => {
                readPaths.push(path);
                return 'hello';
            },
            writeFile: (_path: string, _content: string) => {},
            rename: (_src: string, _dest: string) => {},
            appendFile: (_path: string, _content: string) => {},
            ensureDir: (_path: string) => {},
            readDir: (_path: string) => [],
            deleteFile: (_path: string) => {},
            createWriteStream: (_path: string) => ({
                write: (_chunk: string) => {},
                end: () => {},
            }),
            copy: (_src: string, _dest: string) => {},
            stat: (_path: string) => null,
        };

        const host = new RuleEngineHost();
        host.evaluators.register(
            'fs-probe',
            {
                async evaluate(_rule, context) {
                    const fs = context.fileSystem;
                    if (fs) void (await fs.readFile('/tmp/test.txt'));
                    return { findings: [], fixes: [] };
                },
            },
            'extension',
        );

        await new RuleEngine({ host, fileSystem: fakeFs }).evaluate([rule('probe', 'fs-probe')], '/workdir');
        expect(readPaths).toEqual(['/tmp/test.txt']);
    });
});
