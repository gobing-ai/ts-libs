---
kind: plan
title: Clef decision backend
status: accepted
tags: [brainstorm, decision, clef]
needs_design: true
run_id: 7a38670d-fb5c-43e8-90a9-80265814a5e1
created_at: 2026-10-09
---

# Clef decision backend

## Overview

Add the requested independently published `@gobing-ai/ts-decision-clef` package at
`packages/decision-clef`, implementing the existing `DecisionDriver.ask` contract.
The idea pipeline prepares the work; implementation belongs to the resulting task.

## Approaches

| Approach | Trade-off | Confidence |
|----------|-----------|------------|
| Workers AI REST through existing APIClient | Supports current Node/Bun consumers, needs explicit account/token; smallest complete hosted adapter | HIGH |
| Workers AI binding plus REST | Removes bearer credentials for Worker consumers, but adds a second transport and Cloudflare-specific surface | HIGH on API existence; deferred on scope |
| Local Clef model bridge | Avoids hosted inference but requires an external GPU/Python stack, model provisioning and another process protocol | HIGH on model availability; deferred on scope |

## Recommendation

Proceed with REST, both model selectors, and explicit injection through
`createDecisionMaker({ driver: createClefDriver(options) })`. Default model:
`clef-flash`; per-ask `model` overrides the configured default. This default is a
design choice for the small workflow decisions this repository serves, not a
claim that Flash has equal accuracy. Use `clef` when the consumer wants it.

## Design Summary

Reuse `APIClient.rawRequest` for timeout, headers and status access; map the
Cloudflare REST envelope and Jev-shaped results into the neutral answer types.
Expose the existing neutral question/answer validators from ai-runner so the
new adapter can enforce the same correspondence without duplicating validation.
Validate provider limits before HTTP. Keep driver dependencies one-way and
leave ai-runner backend selectors and ai-decision built-in registration unchanged.
Consumers can register a lazy `clef` factory with the existing registry.
No new SDK, local runtime, retry loop, environment auto-discovery or vision API.

## Scope and affected surfaces

Package manifest, TypeScript source closure/build configs, export barrel,
driver and tests/fixtures, Bun workspace lock, builder discovery and package
README/legal files; ai-runner validator exports and their consumer tests;
decision boundary rules and fixtures; README/package index and numbered docs.
No existing data changes, default backend changes, or reverse package dependency.
Release workflow changes and publication remain operator work.

## Verified premises and sources

Verified 2026-10-09, HIGH confidence:

- The seam is `packages/ai-runner/src/decision/types.ts:104`, with validation at
  `packages/ai-runner/src/decision/validation.ts:26` and `:73`.
- HTTP is owned by `packages/infra/src/api-client.ts:341`; direct fetch is
  forbidden by `.spur/rules/typescript/external-api-boundaries.yaml:12`.
- Registry extension exists at `packages/ai-decision/src/registry.ts:48`.
- [Cloudflare announcement](https://blog.cloudflare.com/clef-decision-models/)
  documents hosted and open-weight models, not an installed local decision server.
- [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) and
  [Clef Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/)
  document the two routes and body model selectors.
- [Input schema](https://developers.cloudflare.com/workers-ai/models/clef/schema-input.json)
  documents 1–64 questions, question IDs of up to 100 characters using letters,
  digits, underscore, dot or hyphen, 2–255 choice options and 2–10 score levels.
  Unlike model-card prose, the hosted schema requires instructions: use the
  question ID when the neutral prompt is absent, null or an empty string.
- [Output schema](https://developers.cloudflare.com/workers-ai/models/clef/schema-output.json)
  documents probability-bearing choice/score/noul results; preserve fractional
  expected scores and provider confidence; do not invent noul confidence.
- [REST guide](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)
  documents bearer authentication and the success/result/errors envelope.
- [Clef model card](https://huggingface.co/Cloudflare/clef) and
  [Flash model card](https://huggingface.co/Cloudflare/clef-flash) document local
  joint-head inference. Generic chat-completion snippets are not a substitute
  for this decision protocol.

## Self-review

PASS: bounded scope, concrete interface, no placeholders or contradictory
model/transport choices. No hosted accuracy or latency guarantee is inferred
from benchmarks. Operator taste and decomposition quiz follow recommendations
automatically under the requested `--auto`.

Verification: HIGH — API existence and contract verified against primary sources;
live inference remains untested.
