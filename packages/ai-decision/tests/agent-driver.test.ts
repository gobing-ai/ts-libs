/**
 * E2E: the agent-backed `llm-agent` decision driver and its registry built-in
 * (task 0115, R1–R10). Every failure mode written in the task Design is one case
 * here, driven through `createDecisionHub` where the outcome is hub-observable
 * and through `createAgentDriver` where the assertion is driver-level (cwd, model,
 * prompt text, detection memoisation).
 *
 * The recorded `output/agent-e2e-transcript.json` is the repeatable artifact: it is
 * generated once and compared on every later run.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
    type AgentRunOptions,
    type AgentRunResult,
    createDecisionMaker,
    type DecisionMaker,
    q,
} from '@gobing-ai/ts-ai-runner';
import { joinPath } from '@gobing-ai/ts-runtime';
import { createDecisionHub, DecisionMakerRegistry, type DecisionResult } from '../src';
import {
    AGENT_INSTRUCTIONS,
    type AgentDetectorPort,
    type AgentPromptRunner,
    createAgentDriver,
    JSON_REPLY_SUFFIX,
} from '../src/agent-driver';

const CATALOG = joinPath(import.meta.dir, 'fixtures', 'agent-e2e.yaml');
const OUTPUT = joinPath(import.meta.dir, 'output', 'agent-e2e-transcript.json');

/** The repeatable e2e artifact: every hub result of this suite, in run order. */
const transcript: Array<{ case: string } & DecisionResult> = [];

interface Call {
    readonly agent: string;
    readonly input: string | undefined;
    readonly model: string | undefined;
    readonly mode: string | undefined;
    readonly cwd: string | undefined;
    readonly timeout: number | undefined;
}

/** Scripted runner: each `runPromptCommand` call draws the next scripted result (or throws it). */
class FakeRunner implements AgentPromptRunner {
    readonly calls: Call[] = [];

    constructor(private readonly queue: Array<Partial<AgentRunResult> | Error> = []) {}

    async runPromptCommand(
        agent: string,
        promptOptions: { input?: string; model?: string; mode?: string; timeoutMs?: number },
        options: AgentRunOptions = {},
    ): Promise<AgentRunResult> {
        this.calls.push({
            agent,
            input: promptOptions.input,
            model: promptOptions.model,
            mode: promptOptions.mode,
            cwd: options.cwd,
            timeout: options.timeout,
        });
        const next = this.queue.shift();
        if (next === undefined) throw new Error('fake runner queue exhausted');
        if (next instanceof Error) throw next;
        return { exitCode: 0, stdout: '', stderr: '', durationMs: 0, ...next };
    }
}

/** Scripted detector: `installed` names report installed; everything else reports absent. */
class FakeDetector implements AgentDetectorPort {
    readonly probes: string[] = [];

    constructor(private readonly installed: readonly string[] = []) {}

    async detectOne(agent: string) {
        this.probes.push(agent);
        const installed = this.installed.includes(agent);
        return {
            name: agent,
            installed,
            version: installed ? '1.0.0' : null,
            channels: [] as string[],
            error: installed ? null : 'not installed',
        };
    }
}

/** Run one case through the hub and record its result for the transcript artifact. */
async function decideAndRecord(name: string, driver: DecisionMaker, id: string): Promise<DecisionResult> {
    const hub = await createDecisionHub({
        registry: new DecisionMakerRegistry({ builtins: false }).register('llm-agent', () => driver),
        catalogs: [CATALOG],
        defaultMaker: 'llm-agent',
        now: () => 0,
    });
    const result = await hub.decide(id, { instructions: 'my invoice was charged twice' });
    transcript.push({ case: name, ...result });
    return result;
}

function driverFor(
    queue: Array<Partial<AgentRunResult> | Error>,
    options: { installed?: readonly string[]; samples?: number; deterministic?: boolean; model?: string } = {},
): { driver: DecisionMaker; runner: FakeRunner; detector: FakeDetector } {
    const runner = new FakeRunner(queue);
    const detector = new FakeDetector(options.installed ?? ['pi']);
    const driver = createDecisionMaker({
        driver: createAgentDriver({
            runner,
            detector,
            ...(options.samples !== undefined ? { samples: options.samples } : {}),
            ...(options.deterministic !== undefined ? { deterministic: options.deterministic } : {}),
            ...(options.model !== undefined ? { model: options.model } : {}),
        }),
    });
    return { driver, runner, detector };
}

const CHOICE = q.choice('Route', { billing: 'Charges', technical: 'Bugs' });

describe('agent driver through the hub (task 0115 R1, R5)', () => {
    test('1. bare JSON is accepted and answers from the declared options', async () => {
        const { driver } = driverFor([{ stdout: '{"triage_route":"billing"}' }], { samples: 1 });
        const result = await decideAndRecord('bare JSON accepted', driver, 'triage_route');
        expect(result).toMatchObject({ source: 'model', reason: 'accepted', value: 'billing' });
    });

    test('2. JSON wrapped in prose and a fenced block is still parsed', async () => {
        const { driver } = driverFor([{ stdout: 'Sure!\n```json\n{"triage_route":"technical"}\n```\n' }], {
            samples: 1,
        });
        const result = await decideAndRecord('prose and fence accepted', driver, 'triage_route');
        expect(result).toMatchObject({ source: 'model', reason: 'accepted', value: 'technical' });
    });

    test('3. garbage stdout falls back with reason error', async () => {
        const { driver } = driverFor([{ stdout: 'I cannot answer that.' }], { samples: 1 });
        const result = await decideAndRecord('garbage stdout', driver, 'triage_route');
        expect(result).toMatchObject({ source: 'default', reason: 'error', value: 'account' });
    });

    test('4. an off-enum value falls back with reason error', async () => {
        const { driver } = driverFor([{ stdout: '{"triage_route":"sales"}' }], { samples: 1 });
        const result = await decideAndRecord('off-enum value', driver, 'triage_route');
        expect(result).toMatchObject({ source: 'default', reason: 'error' });
    });

    test('5. a non-zero exit falls back with reason error', async () => {
        const { driver } = driverFor([{ exitCode: 2, stderr: 'boom: first line\nsecond line' }]);
        const result = await decideAndRecord('non-zero exit', driver, 'triage_route');
        expect(result).toMatchObject({ source: 'default', reason: 'error' });
    });

    test('5b. a null exit code (timeout) falls back with reason timeout', async () => {
        const { driver } = driverFor([{ exitCode: null }]);
        const result = await decideAndRecord('timeout', driver, 'triage_route');
        expect(result).toMatchObject({ source: 'default', reason: 'timeout' });
    });

    test('6. no installed agent falls back with reason no-backend', async () => {
        const { driver, detector, runner } = driverFor([], { installed: [] });
        const result = await decideAndRecord('no agent installed', driver, 'triage_route');
        expect(result).toMatchObject({ source: 'default', reason: 'no-backend' });
        expect(runner.calls).toHaveLength(0);
        expect(detector.probes.length).toBeGreaterThan(0);
    });

    test('score and noul decisions answer from the same driver', async () => {
        const score = driverFor([{ stdout: '{"triage_severity":"2"}' }], { samples: 1 });
        expect(await decideAndRecord('score accepted', score.driver, 'triage_severity')).toMatchObject({
            source: 'model',
            reason: 'accepted',
            value: 2,
        });

        const noul = driverFor([{ stdout: '{"triage_refund":"yes"}' }], { samples: 1 });
        expect(await decideAndRecord('noul accepted', noul.driver, 'triage_refund')).toMatchObject({
            source: 'model',
            reason: 'accepted',
            value: true,
        });
    });
});

describe('isolation and prompt shape (task 0115 R3, R6)', () => {
    test('7. every sample runs in a fresh scratch dir that is gone afterwards', async () => {
        const ok = driverFor([{ stdout: '{"route":"billing"}' }], { samples: 1 });
        const answers = await ok.driver.ask({ state: 's', questions: { route: CHOICE } });
        expect(answers.route).toMatchObject({ label: 'billing' });

        const successCwd = ok.runner.calls[0]?.cwd;
        expect(successCwd).toBeDefined();
        expect(successCwd).not.toBe(process.cwd());
        expect(successCwd?.startsWith(process.cwd())).toBe(false);
        expect(existsSync(successCwd as string)).toBe(false);

        // A failed ask removes its scratch dir too, and picks a different one.
        const bad = driverFor([{ exitCode: 1, stderr: 'nope' }], { samples: 1 });
        await bad.driver.ask({ state: 's', questions: { route: CHOICE } }).catch(() => undefined);
        const failureCwd = bad.runner.calls[0]?.cwd;
        expect(failureCwd).toBeDefined();
        expect(failureCwd).not.toBe(process.cwd());
        expect(existsSync(failureCwd as string)).toBe(false);
        expect(failureCwd).not.toBe(successCwd);
    });

    test('8. deterministic makes exactly one call with one-hot probabilities', async () => {
        const { driver, runner } = driverFor([{ stdout: '{"route":"technical"}' }], {
            deterministic: true,
            samples: 5,
        });
        const answers = await driver.ask({ state: 's', questions: { route: CHOICE } });
        expect(runner.calls).toHaveLength(1);
        expect(answers.route).toEqual({
            kind: 'choice',
            label: 'technical',
            confidence: 1,
            probabilities: { billing: 0, technical: 1 },
        });
    });

    test('9. a per-ask model overrides the configured model', async () => {
        const configured = driverFor([{ stdout: '{"route":"billing"}' }], { samples: 1, model: 'haiku' });
        await configured.driver.ask({ state: 's', questions: { route: CHOICE } });
        expect(configured.runner.calls[0]?.model).toBe('haiku');

        const override = driverFor([{ stdout: '{"route":"billing"}' }], { samples: 1, model: 'haiku' });
        await override.driver.ask({ state: 's', questions: { route: CHOICE }, model: 'opus' });
        expect(override.runner.calls[0]?.model).toBe('opus');
    });

    test('10. the prompt names every key and option and asks for no schema or confidence key', async () => {
        const { driver, runner } = driverFor([{ stdout: '{"route":"billing"}' }], { samples: 1 });
        await driver.ask({ state: 'the state', questions: { route: CHOICE } });
        const input = runner.calls[0]?.input ?? '';
        expect(input).toContain('the state');
        expect(input).toContain('"route"');
        expect(input).toContain('billing');
        expect(input).toContain('technical');
        expect(input).not.toContain('schema');
        expect(input).not.toContain('probability');
        // The example object carries exactly the question keys — never a confidence value.
        expect(JSON_REPLY_SUFFIX({ route: CHOICE })).toContain('{"route":"billing"}');
        expect(input.startsWith(AGENT_INSTRUCTIONS)).toBe(true);
    });

    test('11. the registry pre-registers llm-agent and constructs nothing', () => {
        const registry = new DecisionMakerRegistry();
        expect(registry.names()).toEqual(['typesafe', 'fm-local', 'laya-local', 'llm-agent']);
        expect(registry.has('llm-agent')).toBe(true);
    });

    test('12. detection is memoised on success and retried after a failure', async () => {
        const hit = driverFor([{ stdout: '{"route":"billing"}' }, { stdout: '{"route":"billing"}' }], {
            samples: 1,
        });
        await hit.driver.ask({ state: 's', questions: { route: CHOICE } });
        const probesAfterFirstAsk = hit.detector.probes.length;
        await hit.driver.ask({ state: 's', questions: { route: CHOICE } });
        expect(hit.detector.probes.length).toBe(probesAfterFirstAsk);

        const miss = driverFor([], { installed: [] });
        await miss.driver.ask({ state: 's', questions: { route: CHOICE } }).catch(() => undefined);
        const probesAfterFirstFailure = miss.detector.probes.length;
        await miss.driver.ask({ state: 's', questions: { route: CHOICE } }).catch(() => undefined);
        expect(miss.detector.probes.length).toBe(probesAfterFirstFailure * 2);
    });

    test('frequencies: two of three samples give 2/3 probabilities', async () => {
        const { driver } = driverFor(
            [{ stdout: '{"route":"billing"}' }, { stdout: '{"route":"technical"}' }, { stdout: '{"route":"billing"}' }],
            { samples: 3 },
        );
        const answers = await driver.ask({ state: 's', questions: { route: CHOICE } });
        expect(answers.route).toMatchObject({ label: 'billing', probabilities: { billing: 2 / 3, technical: 1 / 3 } });
    });

    test('a configured agent is used as-is with no probe', async () => {
        const runner = new FakeRunner([{ stdout: '{"route":"billing"}' }]);
        const detector = new FakeDetector([]);
        const driver = createAgentDriver({ agent: 'claude', samples: 1, runner, detector });
        await driver.ask({ state: 's', questions: { route: CHOICE } });
        expect(detector.probes).toHaveLength(0);
        expect(runner.calls[0]?.agent).toBe('claude');
    });
});

describe('agent e2e transcript (task 0115 R5, R10)', () => {
    test('matches the recorded transcript slot for slot', () => {
        if (!existsSync(OUTPUT)) {
            mkdirSync(joinPath(import.meta.dir, 'output'), { recursive: true });
            writeFileSync(OUTPUT, `${JSON.stringify({ suite: 'agent-e2e', results: transcript }, null, 2)}\n`);
        }
        const expected = JSON.parse(readFileSync(OUTPUT, 'utf-8')) as {
            suite: string;
            results: Array<{ case: string } & DecisionResult>;
        };
        expect(expected.suite).toBe('agent-e2e');
        expect(transcript).toHaveLength(expected.results.length);
        for (const result of transcript) expect(expected.results).toContainEqual(result);
    });
});
