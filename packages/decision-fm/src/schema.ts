/**
 * fm request-construction aliases (task 0114 R8). The bodies moved to the
 * dependency-free sampled-driver core in `@gobing-ai/ts-ai-runner`; the fm names
 * stay exported so nothing that imported this module changes.
 */

export {
    buildEnumSchema as buildFmSchema,
    buildPrompt,
    DECISION_INSTRUCTIONS as FM_INSTRUCTIONS,
    declaredOptions,
    type EnumSchema as FmSchema,
    formatDesc,
} from '@gobing-ai/ts-ai-runner';
