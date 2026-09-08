import { describe, expect, test } from 'bun:test';
import { EventBus, setLoggerMuted } from '@gobing-ai/ts-infra';
import type { AgentEvents } from '../src/events';
import {
    type AgentQuotaObservation,
    buildQuotaObservation,
    classifyQuotaErrorRecord,
    MAX_QUOTA_EVIDENCE_BYTES,
    QuotaObservationProducer,
} from '../src/quota';

setLoggerMuted(true);

const OPENAI_QUOTA_429 = JSON.stringify({
    error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' },
});
const ANTHROPIC_CREDIT = JSON.stringify({
    type: 'error',
    error: { type: 'insufficient_credit_balance', message: 'Credit balance is too low' },
});
const RATE_LIMIT = JSON.stringify({ error: { message: 'Rate limit reached', type: 'rate_limit_error', code: '429' } });
const OVERLOAD = JSON.stringify({ error: { type: 'overloaded_error', message: 'Overloaded' } });
const AUTH = JSON.stringify({ error: { type: 'authentication_error', message: 'invalid x-api-key' } });
const CONTEXT = JSON.stringify({
    error: { type: 'invalid_request_error', message: 'prompt is too long: context length exceeded' },
});
const TIMEOUT = JSON.stringify({ error: { type: 'timeout_error', message: 'request timed out' } });

describe('classifyQuotaErrorRecord — precision contract (Spur 0798 R2)', () => {
    test('confirmed usage-allowance exhaustion via provider code', () => {
        expect(classifyQuotaErrorRecord(OPENAI_QUOTA_429)).toEqual({ quota: true, reason: 'insufficient_quota' });
    });

    test('confirmed credit exhaustion from an anthropic-style envelope', () => {
        expect(classifyQuotaErrorRecord(ANTHROPIC_CREDIT)).toEqual({
            quota: true,
            reason: 'insufficient_credit_balance',
        });
    });

    test('usage_limit_reached code confirms allowance exhaustion', () => {
        expect(classifyQuotaErrorRecord('{"error":{"type":"usage_limit_reached"}}')).toEqual({
            quota: true,
            reason: 'usage_limit_reached',
        });
    });

    test('generic HTTP 429 rate limiting is not quota', () => {
        expect(classifyQuotaErrorRecord(RATE_LIMIT)).toEqual({ quota: false });
    });

    test('overload is not quota', () => {
        expect(classifyQuotaErrorRecord(OVERLOAD)).toEqual({ quota: false });
    });

    test('authentication failure is not quota', () => {
        expect(classifyQuotaErrorRecord(AUTH)).toEqual({ quota: false });
    });

    test('context-length limit is not quota', () => {
        expect(classifyQuotaErrorRecord(CONTEXT)).toEqual({ quota: false });
    });

    test('timeout is not quota', () => {
        expect(classifyQuotaErrorRecord(TIMEOUT)).toEqual({ quota: false });
    });

    test('free text mentioning quota outside a structured record is not quota', () => {
        expect(classifyQuotaErrorRecord('the transcript said quota exhausted but the run succeeded')).toEqual({
            quota: false,
        });
    });

    test('quoted prompt content inside error.message never confirms', () => {
        const record = JSON.stringify({
            error: { type: 'invalid_request_error', message: 'your prompt contained "insufficient_quota"' },
        });
        expect(classifyQuotaErrorRecord(record)).toEqual({ quota: false });
    });

    test('CLI noise around the JSON envelope still classifies', () => {
        expect(classifyQuotaErrorRecord(`warn: upstream call failed\n${OPENAI_QUOTA_429}\n`)).toEqual({
            quota: true,
            reason: 'insufficient_quota',
        });
    });

    test('non-JSON stderr is negative', () => {
        expect(classifyQuotaErrorRecord('segmentation fault')).toEqual({ quota: false });
    });

    test('evidence input is bounded to the trailing window', () => {
        const record = `${OPENAI_QUOTA_429}${'x'.repeat(MAX_QUOTA_EVIDENCE_BYTES * 2)}${RATE_LIMIT}`;
        expect(classifyQuotaErrorRecord(record)).toEqual({ quota: false });
    });
});

describe('quota observation identity (Spur 0798 R1)', () => {
    test('observationId is stable across redelivery regardless of timestamp', () => {
        const first = buildQuotaObservation({
            source: 'buffered-error',
            reason: 'insufficient_quota',
            observedAt: new Date('2026-09-07T10:00:00.000Z'),
            attribution: { agent: 'codex' },
        });
        const second = buildQuotaObservation({
            source: 'buffered-error',
            reason: 'insufficient_quota',
            observedAt: new Date('2026-09-07T11:30:00.000Z'),
            attribution: { agent: 'codex' },
        });
        expect(second.observationId).toBe(first.observationId);
    });

    test('different attribution changes identity', () => {
        const a = buildQuotaObservation({
            source: 'health-probe',
            reason: 'provider_quota_exhausted',
            attribution: { model: 'zai/glm-5.2' },
        });
        const b = buildQuotaObservation({
            source: 'health-probe',
            reason: 'provider_quota_exhausted',
            attribution: { model: 'volc/doubao' },
        });
        expect(a.observationId).not.toBe(b.observationId);
    });

    test('observedAt is UTC ISO-8601 with millisecond precision', () => {
        const observation = buildQuotaObservation({ source: 'streaming-error', reason: 'credits_exhausted' });
        expect(observation.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    test('missing attribution stays observable without guessing', () => {
        const observation = buildQuotaObservation({ source: 'buffered-error', reason: 'quota_exceeded' });
        expect(observation.attribution).toBeUndefined();
        expect(observation.observationId).toBeTruthy();
    });

    test('empty attribution fields are dropped, known ones kept', () => {
        const observation = buildQuotaObservation({
            source: 'buffered-error',
            reason: 'quota_exceeded',
            attribution: { projectId: '', agent: 'codex' },
        });
        expect(observation.attribution).toEqual({ agent: 'codex' });
    });

    test('correlation is carried unchanged', () => {
        const correlation = { runId: 'r-1', executionId: 'e-1', actionId: 'a-1' };
        const observation = buildQuotaObservation({ source: 'buffered-error', reason: 'quota_exceeded', correlation });
        expect(observation.correlation).toEqual(correlation);
    });
});

describe('QuotaObservationProducer — one event per observation (Spur 0798 R1)', () => {
    test('emits exactly once per observationId; redelivery is suppressed', () => {
        const events = new EventBus<AgentEvents>();
        const seen: AgentQuotaObservation[] = [];
        events.on('agent.quota.exhausted', (o) => seen.push(o));
        const producer = new QuotaObservationProducer(events);
        const first = buildQuotaObservation({ source: 'buffered-error', reason: 'insufficient_quota' });
        const redelivery = buildQuotaObservation({
            source: 'buffered-error',
            reason: 'insufficient_quota',
            observedAt: new Date('2026-09-07T12:00:00.000Z'),
        });
        expect(producer.produce(first)).toBe(true);
        expect(producer.produce(redelivery)).toBe(false);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.observationId).toBe(first.observationId);
    });

    test('bus-less producer is a no-op', () => {
        const producer = new QuotaObservationProducer(undefined);
        expect(producer.produce(buildQuotaObservation({ source: 'buffered-error', reason: 'quota_exceeded' }))).toBe(
            false,
        );
    });

    test('explicit recovery delivers the typed payload; no automatic producer exists', () => {
        const events = new EventBus<AgentEvents>();
        const recoveries: unknown[] = [];
        events.on('agent.quota.recovered', (r) => recoveries.push(r));
        const producer = new QuotaObservationProducer(events);
        expect(producer.produceRecovery({ observationId: 'qo-abc', recoveredAt: '2026-09-07T12:00:00.000Z' })).toBe(
            true,
        );
        expect(recoveries).toEqual([{ observationId: 'qo-abc', recoveredAt: '2026-09-07T12:00:00.000Z' }]);
    });
});
