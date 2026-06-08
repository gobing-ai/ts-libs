// Public re-export of the shared extension registry (ADR-010). Sourced directly from
// the shared extension core (`@gobing-ai/ts-runtime/extension`); the former
// host/capability-registry.ts shim was removed once the one-release back-compat window closed.
export { type CapabilityEntry, type CapabilityOrigin, CapabilityRegistry } from '@gobing-ai/ts-runtime/extension';
export * from './config/extensions';
export * from './config/loader';
export * from './engine';
// Public dialect helper for the `rg` (ripgrep) evaluator — consumed by the downstream
// rule-file converter and the rg-dialect rule to keep JS-only patterns off the `rg` type.
export { isRipgrepCompatiblePattern } from './evaluators/ripgrep-evaluator';
export type { RuleEngineEvents } from './events';
export * from './fixers/fixers';
export * from './fixers/test-stub-fixer';
export * from './formatters/json';
export * from './formatters/text';
export * from './host/bundled-rules';
export * from './host/rule-engine-host';
export * from './resolvers/test-path-resolver';
export * from './types';
