---
schema_version: 1
name: Agent-backed llm-agent decision driver and registry built-in in ts-ai-decision
status: todo
template: feature-impl
created_at: 2026-10-19T06:34:09.538Z
updated_at: "2026-10-19T17:12:21.160Z"
feature_id: O1
priority: P2
tags:
  - ai-decision
  - ai-runner
  - decision

dependencies: ["0114"]
---

## 0115. Agent-backed llm-agent decision driver and registry built-in in ts-ai-decision

### Background

Implements: R5 — Agent decision driver samples an ai-runner agent in an isolated directory; R6 — Agent maker is a lazy built-in in the decision registry; R10 — Deterministic agent sampling is one sample with one-hot probabilities.

Answers the operator's Q3: treat normal LLM models (any `ts-ai-runner` agent/model) as decision models with contract-compatible answers, built on the sampled-driver core. Visible downstream through `spur decision status` once the consumer's registry exposes `llm-agent`. Shapes: `docs/design/llm-agent-decision-backend.md` § Agent driver and § Registry.

### Requirements

- [ ] R1. Add `packages/ai-decision/src/agent-driver.ts` exporting `createAgentDriver(options?: AgentDriverOptions): AgentDecisionDriver`, `AgentDriverOptions` and `AgentDecisionDriver` (`name: 'llm-agent'`), with the option shape from the design doc § Agent driver. Export all three from `packages/ai-decision/src/index.ts`. It is built on `createSampledDriver` from `@gobing-ai/ts-ai-runner` (0114).
  - `createSampledDriver` options: `{ name: 'llm-agent', samples: options.samples ?? 3, deterministic, concurrency: options.concurrency ?? 1, instructions: AGENT_INSTRUCTIONS, open }`.
- [ ] R2. `AGENT_INSTRUCTIONS` is a module constant that never mentions a "schema", because agents get no `--schema` flag (unlike fm's `FM_INSTRUCTIONS`). Suggested text: "You are a decision function. Read the context and questions, then reply with exactly one JSON object mapping each question key to one of its allowed option strings. No prose, no code, no tool use, no confidence values."
- [ ] R3. `JSON_REPLY_SUFFIX(questions)` is appended to the prompt.
  - It lists each key with its allowed options (`declaredOptions(q)`, imported from the core) and gives one example object built from each key's first option.
  - It never asks for probabilities or confidence (ADR-030).
- [ ] R4. `open(ctx)`:
  1. Resolve the agent.
     - A configured `options.agent` is used as-is, with no probe; a missing CLI then surfaces as a sample failure.
     - Otherwise iterate `TIER1_PRIORITY` (`packages/ai-runner/src/agents/shims.ts:644`) calling `detector.detectOne(a)` sequentially and pick the first with `installed: true` (`agent-detector.ts:5-15`). Memoise the success in the driver closure. Don't memoise failure, so a later ask retries after an install.
     - Nothing installed → `DecisionConfigError('no coding agent available for llm-agent; install one of: <list>', 'AGENT')`.
  2. Create a scratch dir: `joinPath(getProcessEnv().TMPDIR ?? '/tmp', 'llm-agent-' + crypto.randomUUID())`, via `fs.ensureDir`. Use ts-runtime `createNodeFileSystem()` as the default `fs`; `catalog.ts:51` is the precedent.
  3. Return a session:
     - `sample = async () => { const r = await runner.runPromptCommand(agent, { input: instructions + '\n\n' + prompt + JSON_REPLY_SUFFIX(questions), model: ctx.model ?? options.model, mode: 'text' }, { cwd: scratch, timeout: timeoutMs }); … }`
     - `close = () => fs.deleteFile(scratch)`. `deleteFile` is recursive (`file-system.ts:60`).
- [ ] R5. Result mapping inside `sample`:
  - `r.exitCode === null` → `DecisionTimeoutError('llm-agent sample timed out after <ms>ms', timeoutMs)`.
  - Non-zero exit → `DecisionBackendError('llm-agent sample failed (<agent> exit <code>): <stderr first line>', undefined)`.
  - Zero exit → `extractJsonAnswer(r.stdout)`.
  - `AgentRunResult` shape: `ai-runner.ts:22-33`.
- [ ] R6. Isolation invariant: no sample ever runs with `cwd` unset or equal to `process.cwd()`. The claude one-shot shim grants `--permission-mode acceptEdits --allowedTools Write Edit` (`shims.ts:159`), so the scratch dir is the only thing that keeps a decision from editing the caller's workspace. Never pass `continue`, `sessionId` or `sessionDir`.
- [ ] R7. Defaults: `samples` 3, `deterministic` false (deterministic means exactly one sample), `concurrency` 1, `timeoutMs` 120_000. The `runner` and `detector` defaults are `new AiRunner()` and `new AgentDetector({ runner })`, created lazily inside the factory so construction spawns nothing.
- [ ] R8. Registry (`packages/ai-decision/src/registry.ts`):
  - Add `readonly 'llm-agent'?: AgentDriverOptions` to `BuiltinMakerOptions.driverOptions` (`:14`).
  - Register lazily after `laya-local` (`:43-53`): `this.register('llm-agent', () => createDecisionMaker({ driver: createAgentDriver(driverOptions['llm-agent'] ?? {}), ...makerOptions }))`.
  - Update the constructor doc comment ("Pre-registers `typesafe`, `fm-local`, `laya-local` and `llm-agent`") and the `BuiltinMakerOptions` comment ("three" → "four").
  - Update `tests/registry.test.ts` wherever it asserts `names()`.
- [ ] R9. Update `packages/ai-decision/README.md`:
  - Add a maker-table row for `llm-agent`: backend "any ts-ai-runner coding agent"; needs "an installed agent CLI"; probabilities "k-sample frequencies".
  - Add a "Configuring `llm-agent`" subsection covering options, cost (k agent invocations per ask), scratch-dir isolation, and registering extra instances, e.g. `llm-haiku`.
  - Shrink the "Planned" section to the TypeSafe move only.

### Acceptance Criteria

- [ ] AC1 — Agent decision driver samples an ai-runner agent in an isolated directory
- [ ] AC2 — Agent maker is a lazy built-in in the decision registry
- [ ] AC3 — Deterministic agent sampling is one sample with one-hot probabilities

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

**Chosen.** The driver lives inside ts-ai-decision (ADR-038). The hub already bundles backends and depends on ts-ai-runner and ts-runtime (`package.json:54,57`), so there is no new package, dependency or bootstrap.

**Rejected.**
- A new ts-decision-agent package: an extra OIDC bootstrap for no isolation gain.
- Placing it in ts-ai-runner: contradicts ADR-039's contract-only boundary.

**Invariants.**
- Samples never run in the caller's cwd (R6).
- Registration is lazy: `names()` and `has()` construct nothing, and agent detection runs on the first `ask`, not at `resolve`.
- fm is never auto-picked (ADR-031); TIER1_PRIORITY already excludes it.
- No confidence is ever requested.

**Hub behaviour.** An unavailable agent throws `DecisionConfigError` inside `ask`. `hub.ts:335-336` maps any `DecisionConfigError`, during ask or at construction, to `reason: 'no-backend'` (verified 2026-10-19). The design doc was corrected from `'error'` to `'no-backend'`.

**Why sequential detection.** `detectOne` spawns `<agent> --version`. Probing all agents in parallel on every first ask is wasteful, and the first hit is usually `pi`/`omp`/`codex`. A probe time of about 1–2 s on a cold first ask is acceptable and memoised.

**Failure modes, written before the code (each is a case in the E2E test):**
1. Valid bare JSON from the agent → accepted answer; probabilities equal sample frequencies.
2. JSON wrapped in prose or a fenced block → accepted (lenient parse).
3. Garbage stdout → `DecisionBackendError` → hub fallback `reason: 'error'`.
4. Off-enum value → `DecisionBackendError` → fallback `'error'`.
5. Non-zero exit → fallback `'error'`. `exitCode: null` → `DecisionTimeoutError` → fallback `'timeout'`.
6. No agent installed (every `detectOne` returns `installed: false`) → `DecisionConfigError` 'AGENT' → fallback `reason: 'no-backend'`.
7. Every `runPromptCommand` call gets a `cwd` that is not `process.cwd()`, sits under TMPDIR, and is gone after the ask (`existsSync` false). This holds on success and on failure.
8. `deterministic: true` → exactly one `runPromptCommand` call and one-hot probabilities.
9. The per-ask `model` overrides `options.model` in `PromptOptions.model`.
10. The prompt `input` contains every key and every allowed option, and never contains "confidence" or "schema".
11. `new DecisionMakerRegistry().names()` includes `llm-agent` and spawns nothing (the fake runner records zero calls).
12. The detection result is memoised across two asks (a single `detectOne` sequence), and a failed detection is retried on the next ask.

### Plan

1. **E2E test first:** `packages/ai-decision/tests/agent-driver.test.ts`.
   - Fake an `AiRunner` with a scripted `runPromptCommand` queue and an `AgentDetector` stub (both injected), and drive failure modes 1–12 through **`createDecisionHub({ catalogs, registry })`** with a real YAML catalog fixture.
   - Mirror the `tests/hub.test.ts:36-42,165-174` transcript pattern: record each `{case, ...DecisionResult}` and compare it to `packages/ai-decision/tests/output/agent-e2e-transcript.json`. Commit that file as the repeatable artifact; strip `durationMs` before comparing.
   - The test fails at this point because the module is missing.
2. Implement `src/agent-driver.ts` (R1–R7) and export it from `src/index.ts`.
3. Register the built-in (R8) and update `tests/registry.test.ts` name assertions.
4. Optional live smoke, guarded the same way decision-fm's `live.test.ts` is (read it for the guard env var): one real ask against the first installed agent. It is skipped unless the env var is set, so the gate never depends on an installed CLI.
5. README (R9). Set the design-doc § Agent driver status line.
6. Gate: `bun run spur-check && bun run build`, then confirm `git status` shows only intended changes.

**Files touched:**
- `packages/ai-decision/src/{agent-driver.ts (new), index.ts, registry.ts}`
- `packages/ai-decision/tests/{agent-driver.test.ts (new), registry.test.ts}`
- `packages/ai-decision/tests/output/agent-e2e-transcript.json` (new)
- `packages/ai-decision/README.md`
- `docs/design/llm-agent-decision-backend.md`

**Depends on:** 0114 (`createSampledDriver`, `extractJsonAnswer`, `declaredOptions` exported from ts-ai-runner).

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-10-19T17:03:08.435Z feature_id O → P1 (system)
- 2026-10-19T17:03:11.500Z feature_id P1 → O1 (system)

