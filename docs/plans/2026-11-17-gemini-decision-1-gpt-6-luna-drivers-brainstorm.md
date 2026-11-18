---
kind: plan
tags:
  - brainstorm
  - decision-maker
  - drivers
needs_design: true
run_id: 356f0340-6cc7-4fb9-85bb-b23d3df5a8d0
---
# Brainstorm: Gemini Decision 1 & GPT-6 Luna Decisions Drivers

## Overview

Enable Google's **Gemini Decision 1** (`gemini-decision-1`, `POST https://generativelanguage.googleapis.com/v1beta/decisions`) and OpenAI's **GPT-6 Luna Decisions** (`gpt-6-luna`, `POST https://api.openai.com/v1/decisions`) as new `DecisionDriver` implementations compatible with `@gobing-ai/ts-ai-runner`'s `createDecisionMaker({ driver })` and `@gobing-ai/ts-ai-decision`'s `DecisionMakerRegistry`.

Both APIs natively implement the same three-primitive decision contract (`noul`, `choice`, `score`) with zero output tokens and calibrated probabilities/confidences, closely matching `ts-ai-runner`'s neutral `Question` / `Answer` types.

## Approaches

### Approach A: Two Separate Hosted Packages (`@gobing-ai/ts-decision-gemini` and `@gobing-ai/ts-decision-openai`) over `APIClient` (Recommended)

Mirror ADR-037 (`@gobing-ai/ts-decision-clef`): publish `packages/decision-gemini` (`createGeminiDecisionDriver`) and `packages/decision-openai` (`createOpenAIDecisionDriver`) as independent workspace packages using `@gobing-ai/ts-infra`'s portable `APIClient` and `@gobing-ai/ts-ai-runner`'s validators/errors, with optional registration into `DecisionMakerRegistry`.

- **Pros:**
  - Strict dependency isolation: consumers only install the provider package(s) they use.
  - Zero new external vendor SDKs (`@google/genai` or `openai`) — reuses `APIClient` and `fetch` injection for deterministic unit tests, matching `ts-decision-clef`.
  - Clean lockstep publishing and clear `package.json` boundaries.
- **Cons:**
  - Two new workspace packages to bootstrap (manifests, `tsconfig`, `README.md`, `docs/PACKAGE_RELEASE.md` bootstrap).
  - Slight shared HTTP error/serialization boilerplate if not factored carefully (though each driver is ~300–450 LOC like `decision-clef/src/driver.ts`).
- **Sources:**
  - Google Gemini Decisions API (`gemini-decision-1`, `POST /v1beta/decisions`, `x-goog-api-key`, `noul`/`choice`/`score`), accessed 2026-11-17: `https://generativelanguage.googleapis.com/v1beta/decisions` (Google AI Studio / Gemini Decisions API docs).
  - OpenAI Decisions API (`gpt-6-luna`, `POST /v1/decisions`, Bearer token, `noul`/`choice`/`score`), accessed 2026-11-17: `https://api.openai.com/v1/decisions` (OpenAI Decisions API docs).
  - Local precedent: `docs/00_ADR.md` (ADR-037: Hosted Clef Decision Backend Ships as `ts-decision-clef` through `APIClient`), `packages/decision-clef/src/driver.ts`.

### Approach B: Subpath/Built-in Drivers Inside `@gobing-ai/ts-ai-decision`

Add `gemini-driver.ts` and `openai-driver.ts` directly inside `packages/ai-decision` (like `typesafe-driver.ts` and `agent-driver.ts`) and pre-register `gemini-decision` and `openai-luna` as lazy built-ins in `DecisionMakerRegistry`.

- **Pros:**
  - No new workspace packages or npm first-time publish bootstrap.
  - Built-in registry availability out of the box without manual registration.
- **Cons:**
  - Adds `@gobing-ai/ts-infra` dependency (or raw fetch) to `ts-ai-decision`, expanding its surface and coupling two hosted REST adapters into the catalog hub package.
  - Diverges from ADR-037 (`ts-decision-clef`), ADR-029 (`ts-decision-fm`), and ADR-027 (`ts-laya-mlx`) where concrete backends live in dedicated `decision-*` packages.
- **Sources:**
  - `packages/ai-decision/src/registry.ts` (built-in makers `typesafe`, `fm-local`, `laya-local`, `llm-agent`).
  - `docs/00_ADR.md` (ADR-037, ADR-039).

### Approach C: Single Shared Hosted-Decisions Package (`@gobing-ai/ts-decision-hosted`)

Bundle Gemini Decision 1, GPT-6 Luna, and shared REST mapping helpers in one new package.

- **Pros:**
  - Only one new package to bootstrap; easy to share JSON validation and `APIClient` error translation.
- **Cons:**
  - Bundles unrelated vendor transports together; breaks the 1-provider-per-package convention (`decision-clef`, `decision-fm`, `laya-mlx`).
- **Sources:**
  - `packages/` directory layout in `GEMINI.md`.

## Recommendation

**Approach A** (`packages/decision-gemini` and `packages/decision-openai` using `@gobing-ai/ts-infra` `APIClient`), optionally paired with lazy registry integration or documented manual registration per ADR-037. It aligns 1:1 with ADR-037, keeps `ts-ai-runner` and `ts-ai-decision` decoupled from provider transports, and requires zero third-party SDK dependencies.

## Design Summary

- **Packages:** Add `packages/decision-gemini` (`@gobing-ai/ts-decision-gemini`, exporting `createGeminiDecisionDriver` and `GeminiDecisionDriverOptions`) and `packages/decision-openai` (`@gobing-ai/ts-decision-openai`, exporting `createOpenAIDecisionDriver` and `OpenAIDecisionDriverOptions`).
- **Contract & Transport:** Both implement `DecisionDriver` (`name` + `ask()`) from `@gobing-ai/ts-ai-runner`, use `@gobing-ai/ts-infra`'s `APIClient` with explicit credential config (`apiKey`, optional `baseURL`, `model`, `timeoutMs`, `fetch`), and validate questions/answers via `validateQuestions` / `validateAnswers` and `DecisionError` subclasses.
- **Wire Mapping:**
  - Gemini Decision 1: `POST /v1beta/decisions` on `https://generativelanguage.googleapis.com` with `x-goog-api-key`, `model: 'gemini-decision-1'`, `input`, and `questions` (`noul` / `choice` / `score`).
  - GPT-6 Luna Decisions: `POST /v1/decisions` on `https://api.openai.com` with `Authorization: Bearer <apiKey>`, `model: 'gpt-6-luna'`, `input`, and `questions` (`noul` / `choice` / `score`).
- **System Design Needed:** `needs_design: true` — introduces two new workspace packages, ADR update (`docs/00_ADR.md`), `tsconfig` path mappings, and wire-mapping details for both providers' response schemas.
