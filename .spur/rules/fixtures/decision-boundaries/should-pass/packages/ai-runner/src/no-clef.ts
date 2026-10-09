// should-pass fixture (no-clef-driver-import-in-ai-runner) — compliant: ai-runner depends
// only on its own decision seam, never on a concrete driver package.
import { DecisionBackendError } from './errors';

export const seam = DecisionBackendError;
