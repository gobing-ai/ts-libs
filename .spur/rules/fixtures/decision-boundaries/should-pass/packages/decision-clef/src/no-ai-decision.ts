// should-pass fixture (no-ai-decision-import-in-decision-clef) — compliant: the driver
// imports the neutral contract and transport seam only, never the catalog layer.
import { DecisionRequestError } from '@gobing-ai/ts-ai-runner';
import { APIClient } from '@gobing-ai/ts-infra';

export const downward = { DecisionRequestError, APIClient };
