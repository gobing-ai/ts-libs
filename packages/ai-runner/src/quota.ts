import { createHash } from 'node:crypto';
import type { EventBus } from '@gobing-ai/ts-infra';
import type { AgentRunCorrelation } from './ai-runner';
import type { AgentEvents } from './events';

/**
 * Canonical quota-exhaustion codes accepted in structured error-record positions
 * (`error.type` / `error.code`). The set is an exact-match allowlist on purpose:
 * free text never confirms quota (R2 — Spur task 0798). Generic HTTP 429 without
 * one of these codes is rate limiting, not quota exhaustion.
 */
export type QuotaExhaustionReason =
    | 'insufficient_quota'
    | 'insufficient_credit_balance'
    | 'quota_exceeded'
    | 'usage_limit_reached'
    | 'credits_exhausted'
    | 'billing_hard_limit_reached'
    /** Verified by the shipped health probe's quota-aware 429 interpretation (`OmpModelProbe`). */
    | 'provider_quota_exhausted';

/** Where a quota observation was verified. Streaming evidence is a bounded trailing window, never a transcript. */
export type QuotaEvidenceSource = 'buffered-error' | 'streaming-error' | 'health-probe';

/**
 * Exact attribution carried on a quota observation. Every field is optional and
 * only populated from caller-supplied context — the runner never infers project
 * or executor identity (missing attribution stays observable, not guessed).
 */
export interface QuotaAttribution {
    projectId?: string;
    executor?: string;
    agent?: string;
    model?: string;
}

/** A verified quota-exhaustion observation. `observationId` is deterministic, so redelivery keeps identity. */
export interface AgentQuotaObservation {
    /** Stable across redelivery: digest over evidence source, reason, and attribution identity — never timestamps. */
    observationId: string;
    /** UTC ISO-8601 with millisecond precision. */
    observedAt: string;
    evidenceSource: QuotaEvidenceSource;
    reason: QuotaExhaustionReason;
    /** Sanitized provider detail. Only carried when the source guarantees sanitization (health probe). */
    detail?: string;
    /** Exact attribution when supplied by the caller; absent fields mean unknown. */
    attribution?: QuotaAttribution;
    correlation?: AgentRunCorrelation;
}

/** Explicit-recovery payload for `agent.quota.recovered`. Type contract only — no automatic producer, timer, or polling. */
export interface AgentQuotaRecovery {
    /** The observationId whose quota state recovered. */
    observationId: string;
    /** UTC ISO-8601 with millisecond precision. */
    recoveredAt: string;
    attribution?: QuotaAttribution;
    correlation?: AgentRunCorrelation;
}

/** Result of classifying one bounded error record. */
export type QuotaClassification = { quota: true; reason: QuotaExhaustionReason } | { quota: false };

/** Upper bound for error evidence considered by the classifier (bytes, UTF-8). Keeps streaming memory bounded. */
export const MAX_QUOTA_EVIDENCE_BYTES = 8192;

const QUOTA_CODES: ReadonlySet<string> = new Set([
    'insufficient_quota',
    'insufficient_credit_balance',
    'quota_exceeded',
    'usage_limit_reached',
    'credits_exhausted',
    'billing_hard_limit_reached',
]);

/**
 * Classify one error record as quota exhaustion. Accepts only structured
 * provider error envelopes — a JSON object with an `error` object whose
 * `type` or `code` exactly matches a canonical quota code. Free text, quoted
 * prompt content inside `error.message`, plain HTTP 429 rate-limit codes,
 * throttling/overload, authentication, context/output limits, and timeouts
 * all classify as negative (R2). Input is bounded to
 * {@link MAX_QUOTA_EVIDENCE_BYTES} trailing bytes.
 */
export function classifyQuotaErrorRecord(record: string): QuotaClassification {
    const bounded = record.length > MAX_QUOTA_EVIDENCE_BYTES ? record.slice(-MAX_QUOTA_EVIDENCE_BYTES) : record;
    const envelope = tryParseErrorEnvelope(bounded);
    if (envelope === null) return { quota: false };
    const type = typeof envelope.type === 'string' ? envelope.type.toLowerCase() : '';
    const code = typeof envelope.code === 'string' ? envelope.code.toLowerCase() : '';
    for (const candidate of [type, code]) {
        if (QUOTA_CODES.has(candidate)) return { quota: true, reason: candidate as QuotaExhaustionReason };
    }
    return { quota: false };
}

/** Best-effort parse of a JSON provider error envelope (`{ error: { type?, code?, message? } }`). */
function tryParseErrorEnvelope(record: string): { type?: unknown; code?: unknown } | null {
    const start = record.indexOf('{');
    const end = record.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        const parsed: unknown = JSON.parse(record.slice(start, end + 1));
        if (typeof parsed !== 'object' || parsed === null) return null;
        const error = (parsed as { error?: unknown }).error;
        if (typeof error !== 'object' || error === null) return null;
        return error as { type?: unknown; code?: unknown };
    } catch {
        return null;
    }
}

/** Normalize an observation timestamp to UTC ISO-8601 with millisecond precision. */
export function normalizeObservedAt(at: Date): string {
    return at.toISOString();
}

/** Keep only defined, non-empty attribution fields; return undefined when nothing is known. */
function cleanAttribution(attribution: QuotaAttribution): QuotaAttribution | undefined {
    const cleaned: QuotaAttribution = {};
    if (attribution.projectId) cleaned.projectId = attribution.projectId;
    if (attribution.executor) cleaned.executor = attribution.executor;
    if (attribution.agent) cleaned.agent = attribution.agent;
    if (attribution.model) cleaned.model = attribution.model;
    return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

/**
 * Build a quota observation. `observationId` is a SHA-256 digest over the
 * evidence source, reason, and attribution identity — stable across
 * redelivery because it excludes timestamps, correlation, and free text.
 */
export function buildQuotaObservation(params: {
    source: QuotaEvidenceSource;
    reason: QuotaExhaustionReason;
    observedAt?: Date;
    detail?: string;
    attribution?: QuotaAttribution;
    correlation?: AgentRunCorrelation;
}): AgentQuotaObservation {
    const attribution = params.attribution === undefined ? undefined : cleanAttribution(params.attribution);
    const identity = [
        params.source,
        params.reason,
        attribution?.projectId ?? '',
        attribution?.executor ?? '',
        attribution?.agent ?? '',
        attribution?.model ?? '',
    ].join('\0');
    const observationId = `qo-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
    return {
        observationId,
        observedAt: normalizeObservedAt(params.observedAt ?? new Date()),
        evidenceSource: params.source,
        reason: params.reason,
        ...(params.detail !== undefined && params.detail !== '' ? { detail: params.detail } : {}),
        ...(attribution !== undefined ? { attribution } : {}),
        ...(params.correlation !== undefined ? { correlation: params.correlation } : {}),
    };
}

/**
 * Single producer path for quota events. Emits `agent.quota.exhausted` at most
 * once per observationId per producer instance (redelivery of the same quota
 * fact is suppressed). Recovery delivery is explicit-only — callers own
 * recovery detection; this class never schedules, polls, or times anything.
 */
export class QuotaObservationProducer {
    private readonly emitted = new Set<string>();

    constructor(private readonly events: EventBus<AgentEvents> | undefined) {}

    /** Emit one `agent.quota.exhausted`. Returns true when emitted, false when deduped or bus-less. */
    produce(observation: AgentQuotaObservation): boolean {
        if (this.events === undefined || this.emitted.has(observation.observationId)) return false;
        this.emitted.add(observation.observationId);
        void this.events.emit('agent.quota.exhausted', observation);
        return true;
    }

    /** Deliver an explicit `agent.quota.recovered`. Returns true when emitted, false when bus-less. */
    produceRecovery(recovery: AgentQuotaRecovery): boolean {
        if (this.events === undefined) return false;
        void this.events.emit('agent.quota.recovered', recovery);
        return true;
    }
}
