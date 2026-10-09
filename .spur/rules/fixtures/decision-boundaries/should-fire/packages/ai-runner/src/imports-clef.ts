// should-fire fixture (no-clef-driver-import-in-ai-runner) — non-compliant: ai-runner
// statically imports the Clef driver. Clef is consumer-injected; the dependency
// points from Clef to ai-runner, never in reverse (ADR-037).
import { createClefDriver } from '@gobing-ai/ts-decision-clef';

export const driverFactory = createClefDriver;
