# Changelog

## [0.5.31] - 2026-10-19

### Added

- feat(ai-decision): shadow maker evaluation in the decision hub (ADR-040) — the shadow is asked on
  the same question without being awaited and never changes the served answer.
  <!-- src: packages/ai-decision/src/hub.ts:422 (started beside the chain, unawaited) -->
