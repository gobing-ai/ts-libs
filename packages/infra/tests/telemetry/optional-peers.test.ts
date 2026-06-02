import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Structural-optionality guard (mirrors ADR-007's `ts-db/schema` invariant).
 *
 * The optional OTLP peers must be reachable ONLY through the `/otel-node`
 * subpath. If the main barrel (or anything it statically imports) ever pulls one
 * of them, a BYO-collector consumer who omitted the optional peers would crash
 * on `import '@gobing-ai/ts-infra'`. This test walks the static import graph
 * from `src/index.ts` and fails if a forbidden package appears.
 */
const FORBIDDEN = [
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/exporter-metrics-otlp-http',
    '@opentelemetry/resources',
    '@opentelemetry/sdk-trace-node',
    '@opentelemetry/sdk-metrics',
];

const SRC = resolve(import.meta.dir, '../../src');

function collectLocalImports(file: string, seen: Set<string>, externals: Set<string>): void {
    if (seen.has(file)) return;
    seen.add(file);

    const code = readFileSync(file, 'utf8');
    const importRe = /(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/g;
    for (const match of code.matchAll(importRe)) {
        const spec = match[1];
        if (!spec) continue;
        if (spec.startsWith('.')) {
            const resolved = resolveLocal(dirname(file), spec);
            if (resolved) collectLocalImports(resolved, seen, externals);
        } else {
            externals.add(spec);
        }
    }
}

function resolveLocal(fromDir: string, spec: string): string | undefined {
    const base = resolve(fromDir, spec);
    const candidates = [base, `${base}.ts`, `${base}/index.ts`];
    for (const candidate of candidates) {
        try {
            readFileSync(candidate, 'utf8');
            return candidate;
        } catch {
            // try next
        }
    }
    return undefined;
}

describe('optional peer containment', () => {
    test('main barrel does not statically import the optional OTLP peers', () => {
        const externals = new Set<string>();
        collectLocalImports(resolve(SRC, 'index.ts'), new Set(), externals);

        const leaked = FORBIDDEN.filter((pkg) => externals.has(pkg));
        expect(leaked).toEqual([]);
    });

    test('the /otel-node subpath is where the exporters live', () => {
        const externals = new Set<string>();
        collectLocalImports(resolve(SRC, 'telemetry/otel-node.ts'), new Set(), externals);

        // Sanity: the subpath genuinely depends on the exporters (so the
        // containment above is meaningful, not vacuous).
        expect(externals.has('@opentelemetry/exporter-trace-otlp-http')).toBeTrue();
        expect(externals.has('@opentelemetry/exporter-metrics-otlp-http')).toBeTrue();
    });
});
