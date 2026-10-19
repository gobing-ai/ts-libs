---
schema_version: 1
name: Agent-backed llm-agent decision driver and registry built-in in ts-ai-decision
status: done
template: feature-impl
created_at: 2026-10-19T06:34:09.538Z
updated_at: "2026-10-19T21:32:50.111Z"
feature_id: O1
priority: P2
tags:
  - ai-decision
  - ai-runner
  - decision

dependencies: ["0114"]
done_forced: "false"
done_reason: unforced close; PASS artifact at .spur/memory/evidence/0115-verdict.json
---

## 0115. Agent-backed llm-agent decision driver and registry built-in in ts-ai-decision

### Background

Implements: R5 — Agent decision driver samples an ai-runner agent in an isolated directory; R6 — Agent maker is a lazy built-in in the decision registry; R10 — Deterministic agent sampling is one sample with one-hot probabilities.

Answers the operator's Q3: treat normal LLM models (any `ts-ai-runner` agent/model) as decision models with contract-compatible answers, built on the sampled-driver core. Visible downstream through `spur decision status` once the consumer's registry exposes `llm-agent`. Shapes: `docs/design/llm-agent-decision-backend.md` § Agent driver and § Registry.

### Requirements

- [x] R1. Add `packages/ai-decision/src/agent-driver.ts` exporting `createAgentDriver(options?: AgentDriverOptions): AgentDecisionDriver`, `AgentDriverOptions` and `AgentDecisionDriver` (`name: 'llm-agent'`), with the option shape from the design doc § Agent driver. Export all three from `packages/ai-decision/src/index.ts`. It is built on `createSampledDriver` from `@gobing-ai/ts-ai-runner` (0114).
  - `createSampledDriver` options: `{ name: 'llm-agent', samples: options.samples ?? 3, deterministic, concurrency: options.concurrency ?? 1, instructions: AGENT_INSTRUCTIONS, open }`.
- [x] R2. `AGENT_INSTRUCTIONS` is a module constant that never mentions a "schema", because agents get no `--schema` flag (unlike fm's `FM_INSTRUCTIONS`). Suggested text: "You are a decision function. Read the context and questions, then reply with exactly one JSON object mapping each question key to one of its allowed option strings. No prose, no code, no tool use, no confidence values."
- [x] R3. `JSON_REPLY_SUFFIX(questions)` is appended to the prompt.
  - It lists each key with its allowed options (`declaredOptions(q)`, imported from the core) and gives one example object built from each key's first option.
  - It never asks for probabilities or confidence (ADR-030).
- [x] R4. `open(ctx)`:
  1. Resolve the agent.
     - A configured `options.agent` is used as-is, with no probe; a missing CLI then surfaces as a sample failure.
     - Otherwise iterate `TIER1_PRIORITY` (`packages/ai-runner/src/agents/shims.ts:644`) calling `detector.detectOne(a)` sequentially and pick the first with `installed: true` (`agent-detector.ts:5-15`). Memoise the success in the driver closure. Don't memoise failure, so a later ask retries after an install.
     - Nothing installed → `DecisionConfigError('no coding agent available for llm-agent; install one of: <list>', 'AGENT')`.
  2. Create a scratch dir: `joinPath(getProcessEnv().TMPDIR ?? '/tmp', 'llm-agent-' + crypto.randomUUID())`, via `fs.ensureDir`. Use ts-runtime `createNodeFileSystem()` as the default `fs`; `catalog.ts:51` is the precedent.
  3. Return a session:
     - `sample = async () => { const r = await runner.runPromptCommand(agent, { input: instructions + '\n\n' + prompt + JSON_REPLY_SUFFIX(questions), model: ctx.model ?? options.model, mode: 'text' }, { cwd: scratch, timeout: timeoutMs }); … }`
     - `close = () => fs.deleteFile(scratch)`. `deleteFile` is recursive (`file-system.ts:60`).
- [x] R5. Result mapping inside `sample`:
  - `r.exitCode === null` → `DecisionTimeoutError('llm-agent sample timed out after <ms>ms', timeoutMs)`.
  - Non-zero exit → `DecisionBackendError('llm-agent sample failed (<agent> exit <code>): <stderr first line>', undefined)`.
  - Zero exit → `extractJsonAnswer(r.stdout)`.
  - `AgentRunResult` shape: `ai-runner.ts:22-33`.
- [x] R6. Isolation invariant: no sample ever runs with `cwd` unset or equal to `process.cwd()`. The claude one-shot shim grants `--permission-mode acceptEdits --allowedTools Write Edit` (`shims.ts:159`), so the scratch dir is the only thing that keeps a decision from editing the caller's workspace. Never pass `continue`, `sessionId` or `sessionDir`.
- [x] R7. Defaults: `samples` 3, `deterministic` false (deterministic means exactly one sample), `concurrency` 1, `timeoutMs` 120_000. The `runner` and `detector` defaults are `new AiRunner()` and `new AgentDetector({ runner })`, created lazily inside the factory so construction spawns nothing.
- [x] R8. Registry (`packages/ai-decision/src/registry.ts`):
  - Add `readonly 'llm-agent'?: AgentDriverOptions` to `BuiltinMakerOptions.driverOptions` (`:14`).
  - Register lazily after `laya-local` (`:43-53`): `this.register('llm-agent', () => createDecisionMaker({ driver: createAgentDriver(driverOptions['llm-agent'] ?? {}), ...makerOptions }))`.
  - Update the constructor doc comment ("Pre-registers `typesafe`, `fm-local`, `laya-local` and `llm-agent`") and the `BuiltinMakerOptions` comment ("three" → "four").
  - Update `tests/registry.test.ts` wherever it asserts `names()`.
- [x] R9. Update `packages/ai-decision/README.md`:
  - Add a maker-table row for `llm-agent`: backend "any ts-ai-runner coding agent"; needs "an installed agent CLI"; probabilities "k-sample frequencies".
  - Add a "Configuring `llm-agent`" subsection covering options, cost (k agent invocations per ask), scratch-dir isolation, and registering extra instances, e.g. `llm-haiku`.
  - Shrink the "Planned" section to the TypeSafe move only.


**Confidence granularity (added 2026-10-19 from downstream evidence).** With default k=3 over a two-option choice, `entropyConfidence` yields 1.0 (unanimous) or 0.08 (2-of-3); no non-unanimous result clears the hub floor (0.7; Spur catalogs 0.8). `llm-agent` therefore accepts only unanimous samples. That is intended (ADR-030: no invented confidence) but must be documented in the README maker table ("accepted = all samples agreed") and is NOT a reason to raise default k. Evidence: Spur `review-failure-class` on fm-local answered `fix` at 1.0 in 15/15 runs; see `docs/design/llm-agent-decision-backend.md` § Agent driver, "Confidence granularity".

### Acceptance Criteria

- [x] AC1 — Agent decision driver samples an ai-runner agent in an isolated directory
- [x] AC2 — Agent maker is a lazy built-in in the decision registry
- [x] AC3 — Deterministic agent sampling is one sample with one-hot probabilities

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

| File | Lines | Change |
| --- | --- | --- |
| `packages/ai-decision/src/agent-driver.ts` | 1-164 | New `llm-agent` driver: `AGENT_INSTRUCTIONS`, `JSON_REPLY_SUFFIX`, `AgentDriverOptions`, `AgentDecisionDriver`, `createAgentDriver`, plus the `AgentPromptRunner` / `AgentDetectorPort` injection seams. Built on `createSampledDriver` (defaults: samples 3, concurrency 1, timeoutMs 120000); `open` resolves the agent, creates a per-ask scratch dir under TMPDIR, and `sample` runs one `runPromptCommand` with `cwd` pinned to that dir, mapping a null exit to `DecisionTimeoutError`, a non-zero exit to `DecisionBackendError`, and stdout through `extractJsonAnswer`. |
| `packages/ai-decision/src/index.ts` | 1 | Re-export the new module from the barrel. |
| `packages/ai-decision/src/registry.ts` | 13-18, 34, 59-63 | `BuiltinMakerOptions.driverOptions` gains `'llm-agent'`; the built-in is registered lazily after `laya-local`; the constructor doc lists four built-ins. |
| `packages/ai-decision/tests/agent-driver.test.ts` | 1-304 | E2E suite: hub-driven cases for the seven hub-observable failure modes (accepted, prose/fence, garbage, off-enum, non-zero exit, timeout, no agent), driver-level cases for scratch-dir isolation, deterministic one-hot, per-ask model override, prompt shape, registry names, detection memoisation/retry, and frequency arithmetic. Records `output/agent-e2e-transcript.json`. |
| `packages/ai-decision/tests/fixtures/agent-e2e.yaml` | 1-31 | Real YAML catalog (`maker: llm-agent`) with one choice, one score and one noul decision, loaded by the hub in the suite. |
| `packages/ai-decision/tests/output/agent-e2e-transcript.json` | 1-105 | The repeatable artifact: every hub result of the suite, with `now: () => 0` so `durationMs` is deterministic. |
| `packages/ai-decision/tests/registry.test.ts` | 45, 59, 217-235 | Built-in name assertions include `llm-agent`; a new case resolves `llm-agent` from injected driver options (covering the new lazy factory, which also lifts the file above the per-file coverage threshold). |
| `packages/decision-clef/tests/registry.test.ts` | 98, 100 | Downstream assertion of the built-in name list updated for the fourth built-in. |
| `packages/ai-decision/README.md` | 31, 157, 168-205, 245 | Maker-table row for `llm-agent`, the `registry.names()` example, a "Configuring `llm-agent`" section (options table, k-per-ask cost, scratch-dir isolation, extra instances) and a shrunken "Planned" section. |
| `docs/design/llm-agent-decision-backend.md` | 111 | § Agent driver status line records that the driver and its built-in shipped in 0115. |

Isolation is the load-bearing invariant: every sample runs with `cwd` set to a fresh scratch dir under the runtime temp dir and never the caller's workspace, because the claude one-shot shim grants `--permission-mode acceptEdits --allowedTools Write Edit`. The dir is removed in `close`, on success and failure. Detection runs inside `ask`, never at registration, is memoised on success only, and a configured `agent` is used as-is without a probe. No confidence or probability is ever requested of the agent (ADR-030); the prompt asks for the enum values only, and the example object carries exactly the question keys.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | factory at `packages/ai-decision/src/agent-driver.ts:100`, sampled-core delegation with name/samples 3/concurrency 1/AGENT_INSTRUCTIONS at `packages/ai-decision/src/agent-driver.ts:127-132`; barrel `packages/ai-decision/src/index.ts:1` |
| R2 | MET | AGENT_INSTRUCTIONS constant with no "schema" wording at `packages/ai-decision/src/agent-driver.ts:68-71`; asserted at `packages/ai-decision/tests/agent-driver.test.ts:234` |
| R3 | MET | reply suffix lists keys with declared options and one example at `packages/ai-decision/src/agent-driver.ts:78-91`; no confidence key asserted at `packages/ai-decision/tests/agent-driver.test.ts:234` |
| R4 | MET | configured agent without probe at `packages/ai-decision/src/agent-driver.ts:112`, TIER1_PRIORITY scan with success-only memo at `packages/ai-decision/src/agent-driver.ts:113-119`, AGENT config error at `packages/ai-decision/src/agent-driver.ts:121-124`, scratch dir at `packages/ai-decision/src/agent-driver.ts:135-136`, close deletes at `packages/ai-decision/src/agent-driver.ts:160` |
| R5 | MET | null exit → timeout at `packages/ai-decision/src/agent-driver.ts:148-149`, non-zero exit → backend error with first stderr line at `packages/ai-decision/src/agent-driver.ts:151-155`, zero exit → JSON extraction at `packages/ai-decision/src/agent-driver.ts:158` |
| R6 | MET | every sample passes `cwd: scratch` at `packages/ai-decision/src/agent-driver.ts:144-146`; no continue/sessionId/sessionDir set anywhere in the file; isolation test `packages/ai-decision/tests/agent-driver.test.ts:188` |
| R7 | MET | timeout default and lazy runner/detector inside the factory at `packages/ai-decision/src/agent-driver.ts:101-107`; registry resolves without spawning at `packages/ai-decision/tests/agent-driver.test.ts:249` |
| R8 | MET | driverOptions key at `packages/ai-decision/src/registry.ts:24`, doc comments at `packages/ai-decision/src/registry.ts:16` and `packages/ai-decision/src/registry.ts:45`, lazy registration at `packages/ai-decision/src/registry.ts:85-86`; names asserted at `packages/ai-decision/tests/registry.test.ts:45` |
| R9 | MET | maker-table row with unanimity note at `packages/ai-decision/README.md:31`, sampled-maker granularity prose at `packages/ai-decision/README.md:183-187`, Configuring section at `packages/ai-decision/README.md:217` |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| R5 — Agent decision driver samples an ai-runner agent in an isolated directory | MET | test | `packages/ai-decision/tests/agent-driver.test.ts:188` scratch dir fresh and removed; failure mappings at `packages/ai-decision/tests/agent-driver.test.ts:138-162`; focused run 35 pass / 0 fail this run |
| R6 — Agent maker is a lazy built-in in the decision registry | MET | test | `packages/ai-decision/tests/agent-driver.test.ts:249` and `packages/ai-decision/tests/registry.test.ts:217` lazy resolve + memoised identity |
| R10 — Deterministic agent sampling is one sample with one-hot probabilities | MET | test | `packages/ai-decision/tests/agent-driver.test.ts:209` one call, one-hot probabilities |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

**Scope.** The 0115 diff on `sp/runall-o1-3ecd` — 5 modified and 4 new paths. The driver, the registry
change, the E2E suite, the catalog fixture, the recorded transcript and both doc edits were read in
full; `bun run spur-check` (3069 pass / 0 fail, all rules green) and `bun run build` (12/12 packages)
were re-run on the final tree.

**Functional traceability.** R1-R9 MET, each row carrying a `path:line` anchor in the run's review
answer (`.spur/run/b415c17e-cd21-4555-95ea-3dd639c80b54-review-answer.txt`); AC-1..AC-3 MET with
executable (`test`/`command`) evidence. `spur task verdict --from-answer` derives PASS and writes
`.spur/run/0115-verdict.json`.

**SECUA.** Security: the agent CLI is spawned through the existing `AiRunner` seam and every sample
pins `cwd` to a per-ask scratch directory, so a decision cannot edit the caller's workspace even
though the claude shim grants write tools; no new dependency, network path or credential handling.
Errors: every failure maps into the decision taxonomy (`DecisionConfigError` code `AGENT`,
`DecisionTimeoutError`, `DecisionBackendError`) so the hub degrades to its declared fallback instead
of rejecting. Correctness: the shared core owns validation, concurrency, enum checking and
estimation; the driver supplies one session hook. Usability: the README documents options, k-per-ask
cost, isolation and registering extra instances. Architecture: the driver lives where the dependencies
already point, adds no package edge, and leaves the registry lazy and the hub untouched.

**Architectural depth.** A thin adapter — one `open` hook plus three failure mappings over the shared
core. The injection seams are narrow `Pick`s of the existing classes, so production passes the real
objects and tests pass fakes without a mocking framework.

**Findings.**

| Priority | Finding | Location | Disposition |
| --- | --- | --- | --- |
| P4 | With no `agent` configured, the first ask probes up to nine agent CLIs sequentially (about 1-2 s cold); the documented trade-off for not spawning nine version probes at once, memoised on success. | `packages/ai-decision/src/agent-driver.ts:105` | RESOLVED (intentional, documented cost) |

Verdict: PASS
Confidence: HIGH

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-10-19T17:03:08.435Z feature_id O → P1 (system)
- 2026-10-19T17:03:11.500Z feature_id P1 → O1 (system)
- 2026-10-19T18:21:52.733Z todo → wip (system)
- 2026-10-19T18:23:05.580Z wip → testing (system)
- 2026-10-19T18:25:12.756Z testing → done (system)

