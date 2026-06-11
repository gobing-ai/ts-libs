/**
 * High-level tracing helpers for application code.
 */

import { context, INVALID_SPAN_CONTEXT, type Span, type SpanOptions, type Tracer, trace } from '@opentelemetry/api';
import { getResolvedConfig, getTracer } from './sdk';

/**
 * Master switch (`TelemetryConfig.enabled`): when explicitly disabled, infra
 * helpers bypass the global provider entirely. An explicitly injected tracer
 * (ADR-009 addendum structural port) is honored regardless — the caller opted in.
 */
function isSuppressed(tracer: Tracer | undefined): boolean {
    return tracer === undefined && !getResolvedConfig().enabled;
}

/** A non-recording span satisfying the `Span` interface — every method is a no-op. */
function nonRecordingSpan(): Span {
    return trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
}

/**
 * Execute an async function within an active OTel span.
 * The span is automatically ended and its status set on error.
 */
export async function traceAsync<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    options?: SpanOptions,
    tracer?: Tracer,
): Promise<T> {
    if (isSuppressed(tracer)) return fn(nonRecordingSpan());

    const resolvedTracer = tracer ?? getTracer();
    return resolvedTracer.startActiveSpan(name, options ?? {}, async (span) => {
        try {
            return await fn(span);
        } catch (err) {
            span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
            throw err;
        } finally {
            span.end();
        }
    });
}

/**
 * Execute a synchronous function within an active OTel span.
 * The span is automatically ended and its status set on error.
 */
export function traceSync<T>(name: string, fn: (span: Span) => T, options?: SpanOptions, tracer?: Tracer): T {
    if (isSuppressed(tracer)) return fn(nonRecordingSpan());

    const resolvedTracer = tracer ?? getTracer();
    return resolvedTracer.startActiveSpan(name, options ?? {}, (span) => {
        try {
            return fn(span);
        } catch (err) {
            span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
            throw err;
        } finally {
            span.end();
        }
    });
}

/** Set key-value attributes on the currently active span. No-op when no span is recording. */
export function addSpanAttributes(attributes: Record<string, string | number | boolean>): void {
    const span = trace.getActiveSpan();
    if (span?.isRecording()) {
        span.setAttributes(attributes);
    }
}

/** Add a named event to the currently active span. No-op when no span is recording. */
export function addSpanEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
    const span = trace.getActiveSpan();
    if (span?.isRecording()) {
        span.addEvent(name, attributes);
    }
}

/** Get the currently active span from context, or `undefined`. */
export function getActiveSpan(): Span | undefined {
    return trace.getActiveSpan() ?? undefined;
}

/** Execute a function with a specific span set as the active span in context. */
export function withSpan<T>(span: Span, fn: () => T): T {
    return context.with(trace.setSpan(context.active(), span), fn);
}

export type { Span, SpanOptions, Tracer } from '@opentelemetry/api';
export { context, propagation, trace } from './sdk';
