/**
 * High-level tracing helpers for application code.
 */

import { context, type Span, type SpanOptions, type Tracer, trace } from '@opentelemetry/api';
import { getTracer } from './sdk';

export async function traceAsync<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    options?: SpanOptions,
    tracer?: Tracer,
): Promise<T> {
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

export function traceSync<T>(name: string, fn: (span: Span) => T, options?: SpanOptions, tracer?: Tracer): T {
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

export function addSpanAttributes(attributes: Record<string, string | number | boolean>): void {
    const span = trace.getActiveSpan();
    if (span?.isRecording()) {
        span.setAttributes(attributes);
    }
}

export function addSpanEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
    const span = trace.getActiveSpan();
    if (span?.isRecording()) {
        span.addEvent(name, attributes);
    }
}

export function getActiveSpan(): Span | undefined {
    return trace.getActiveSpan() ?? undefined;
}

export function withSpan<T>(span: Span, fn: () => T): T {
    return context.with(trace.setSpan(context.active(), span), fn);
}

export type { Span, SpanOptions, Tracer } from '@opentelemetry/api';
export { context, propagation, trace } from './sdk';
