/**
 * @gobing-ai/ts-decision-fm — Apple on-device Foundation Model decision backend
 * driving the macOS `fm` CLI over a one-shot process bridge (ADR-029).
 * Implements the {@link DecisionDriver} interface for `@gobing-ai/ts-ai-runner`;
 * probabilities are empirical sample frequencies (ADR-030).
 */

export { createFmDriver, type FmDecisionDriver, type FmDriverOptions } from './driver';
export { entropyConfidence, estimateChoice, estimateNoul, estimateScore } from './estimate';
export {
    availableArgv,
    countPromptTokens,
    countTokensArgv,
    type FmGuardrails,
    parseFmRespond,
    probeFmAvailability,
    requireEnumValue,
    respondArgv,
    runFmRespond,
} from './fm-process';
export { buildFmSchema, buildPrompt, declaredOptions, FM_INSTRUCTIONS, type FmSchema, formatDesc } from './schema';
