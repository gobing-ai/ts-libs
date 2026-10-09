// should-fire fixture (no-ai-decision-import-in-decision-clef) — non-compliant: the hosted
// driver sits BELOW the catalog layer and must not import it (ADR-037).
import { DecisionMakerRegistry } from '@gobing-ai/ts-ai-decision';

export const registryLayer = DecisionMakerRegistry;
