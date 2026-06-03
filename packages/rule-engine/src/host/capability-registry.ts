/**
 * Compatibility re-export (ADR-010 / task 0008).
 *
 * The capability registry now lives in the shared plugin core
 * (`@gobing-ai/ts-runtime/plugin`). This module re-exports it from the original
 * path so the public barrel and existing importers keep working unchanged. New
 * code should import from `@gobing-ai/ts-runtime/plugin` directly.
 */
export { type CapabilityEntry, type CapabilityOrigin, CapabilityRegistry } from '@gobing-ai/ts-runtime/plugin';
