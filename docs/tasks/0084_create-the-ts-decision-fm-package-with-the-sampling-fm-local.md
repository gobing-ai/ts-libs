---
schema_version: 1
name: Create the ts-decision-fm package with the sampling fm-local driver
status: done
template: feature-impl
created_at: 2026-09-23T16:30:08.844Z
updated_at: "2026-09-23T19:11:19.639Z"
feature_id: K
priority: P1
tags:
  - decision-fm
  - fm
  - new-package
estimate_hours: 8

---

## 0084. Create the ts-decision-fm package with the sampling fm-local driver

### Background

Implements: R6 — The workspace publishes ts-decision-fm as a lockstep-versioned package; R7 — The fm driver satisfies the same DecisionDriver contract as the existing backends; R8 — Choice probabilities come from repeated samples and never from self-reported confidence; R9 — Deterministic mode answers with a single greedy sample; R10 — Every generated schema carries the property-order key that fm requires; R13 — An oversized question is rejected before the model is invoked; R14 — fm failures surface through the existing decision error taxonomy; R15 — Missing host prerequisites are reported before any decision is attempted; R16 — The test suites pass on Linux CI and exercise the live model only on capable hosts (decision-fm half). Design of record: ADR-029, ADR-030 and docs/design/decision-fm-backend.md. Modelled on packages/laya-mlx, minus the Python worker.

**Refine corrections (2026-09-23)**
- "prompt on stdin" (R4, R5) → `ProcessExecutor.run({command, args, cwd, env, timeout})` has no stdin input (`packages/runtime/src/process-executor.ts`) → prompt is the final positional argument for both `fm count-tokens -q -i <instr> <prompt>` and `fm respond`; both forms verified live.
- "options include `platform`" → laya-mlx pins both platform and arch (`packages/laya-mlx/src/worker-client.ts:118` `validateHostPrerequisites`) and ts-runtime has no os/arch helper → options gain `arch`; defaults are `process.platform`/`process.arch` exactly as laya-mlx reads them.
- "temp file via ts-runtime FileSystem" → FileSystem has `writeFile`/`deleteFile` but no temp-dir helper → path = `joinPath(getProcessEnv().TMPDIR ?? '/tmp', `fm-schema-${crypto.randomUUID()}.json`)`, deleted in `finally`; `getProcessEnv` is exported from `@gobing-ai/ts-runtime` (`config.ts:96`).
- "task-local check: pack lists only dist, README and package.json" → laya-mlx `files` is `dist, src, worker, README.md, LICENSE, NOTICE` → decision-fm mirrors it minus `worker`; the check lists `dist`, `src`, README, LICENSE, NOTICE, package.json.
- "missing fm reported before spawning" → absence can only be observed by spawning → the prerequisite probe is `fm available --model system`; ENOENT/spawn failure ⇒ `DecisionConfigError` "fm not found", non-zero exit ⇒ `DecisionConfigError` carrying fm's stderr/stdout reason (e.g. `modelNotReady`). Platform/arch checks still run before any spawn.
- Error constructors (`packages/ai-runner/src/decision/errors.ts`) take extra positional fields: `DecisionConfigError(msg, variable)`, `DecisionRequestError(msg, status, bodySummary)`, `DecisionBackendError(msg, status)`, `DecisionTimeoutError(msg, timeoutMs)`; `status` is `undefined` for a local process.

### Requirements

- [x] R1. Scaffold `packages/decision-fm` as `@gobing-ai/ts-decision-fm` at the current lockstep version (0.5.2), deps `@gobing-ai/ts-ai-runner` + `@gobing-ai/ts-runtime` as `workspace:*`, tsconfig paths per ADR-004/012; `package.json`/`tsconfig*.json`/scripts mirror laya-mlx minus `worker` and the `parity` script; LICENSE and NOTICE copied.
- [x] R2. Export `createFmDriver(options?: FmDriverOptions): FmDecisionDriver` with the exact shape in docs/design/decision-fm-backend.md § Main export: `name: 'fm-local'`, `estimator: { kind: 'sample-frequency'; samples; greedy }`; options `samples` (5), `deterministic` (false), `maxPromptTokens` (6000), `requestTimeoutMs` (30000), `guardrails`, `fmPath` ('fm'), `executor`, `platform`, `arch`.
- [x] R3. One JSON schema per ask over the whole question map: root object with `x-order` listing every key, `additionalProperties: false`, all keys required; choice → string enum of labels, score → string enum `"0"…"n-1"`, noul → `["yes","no"]`. Written to a uniquely named temp file, deleted in `finally`.
- [x] R4. Pre-flight `fm count-tokens -q -i <instructions> <prompt>`; a count above `maxPromptTokens` raises `DecisionRequestError` naming both numbers and no `fm respond` runs.
- [x] R5. Sampling: `samples` sequential `fm respond --no-stream --schema <file> -i <instructions> [--guardrails <g>] <prompt>`; deterministic mode runs exactly one call with `-g`. Each stdout is parsed as JSON and read by key.
- [x] R6. Estimation per design § Probability estimation: frequencies over all declared labels/levels (unsampled = 0), argmax with declaration-order / lower-level tie-break, `confidence = 1 − H(p)/ln(n)`; noul `{kind:'noul', probability: yes/k}`. Neither prompt nor schema contains a confidence field.
- [x] R7. Error mapping per design § Errors table, every row; fm text is carried in the message; no refusal or malformed output becomes an answer.
- [x] R8. Host prerequisites checked once per driver, before the first ask: non-darwin or non-arm64 ⇒ `DecisionConfigError` without spawning; then the `fm available --model system` probe per Background corrections.
- [x] R9. `ask({ model })` accepts only `undefined` or `'system'`; anything else ⇒ `DecisionRequestError`. A question with fewer than two options ⇒ `DecisionRequestError`.
- [x] R10. Tests: stubbed `ProcessExecutor` with `platform: 'darwin', arch: 'arm64'` pinned covers R3–R9; live tests run only when `process.platform === 'darwin'` and the availability probe exits 0.
- [x] R11. README: prerequisites, options, estimator semantics (agreement, not calibration; 1/k resolution), latency cost (~0.3 s × k per ask).

Out of scope: `fm serve`, PCC models, parallel sampling, the `fm-local` selector in ts-ai-runner (task 0085), and the first npm publish (operator bootstrap per docs/PACKAGE_RELEASE.md). No `.github/workflows/` edit is needed — the root workspaces glob covers `packages/*`.

### Acceptance Criteria

- [x] AC1 — The workspace publishes ts-decision-fm as a lockstep-versioned package
- [x] AC2 — The fm driver satisfies the same DecisionDriver contract as the existing backends
- [x] AC3 — Choice probabilities come from repeated samples and never from self-reported confidence
- [x] AC4 — Deterministic mode answers with a single greedy sample
- [x] AC5 — Every generated schema carries the property-order key that fm requires
- [x] AC6 — An oversized question is rejected before the model is invoked
- [x] AC7 — fm failures surface through the existing decision error taxonomy
- [x] AC8 — Missing host prerequisites are reported before any decision is attempted
- [x] AC9 — The test suites pass on Linux CI and exercise the live model only on capable hosts

Task-local check: `npm pack --dry-run` in packages/decision-fm lists `dist`, `src`, README.md, LICENSE, NOTICE and package.json — no `tests` or `worker`.

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-09-23T17:08:03.085Z

- Closed: prompt passed as positional argv (no stdin seam in ProcessExecutor); fm's argv length limit is far above the ~8K-token window, so no file indirection is needed.
- Closed: one failed sample fails the whole ask — partial estimates would silently change k.
- Closed: first npm publish is an operator bootstrap, outside this task.

### Design

Authoritative detail lives in docs/design/decision-fm-backend.md (§ Main export, § Request flow, § Probability estimation, § Errors); this section records only the task-level shape.

**Files.** `src/index.ts` (barrel), `src/driver.ts` (`createFmDriver`, ask loop), `src/schema.ts` (schema + instructions builder), `src/estimate.ts` (frequencies, entropy confidence, answer assembly), `src/fm-process.ts` (argv builders, run + error mapping, prerequisite probe). Tests mirror under `tests/`.

**Why one-shot processes (ADR-029).** ~0.3 s warm per call; `fm serve` offers no logprobs and rejects `n>1`, so a server lifecycle buys nothing.

**Why sample frequency (ADR-030).** fm exposes no logprobs on CLI or server; a self-reported confidence field would be fabricated calibration, which the decision contract forbids.

**Error discrimination.** Match on fm's stable text: `exceeded the model's context size` ⇒ `DecisionRequestError`; `safety guardrails were triggered` ⇒ `DecisionBackendError`, not retried; executor timeout ⇒ `DecisionTimeoutError(msg, requestTimeoutMs)`; other non-zero, non-JSON stdout or a value outside the enum ⇒ `DecisionBackendError`. One failed sample fails the ask (no partial estimate from k−1).

**Invariants.** No `node:*`, `Bun.*` or `process.env` imports — only `ProcessExecutor`, `FileSystem`, `joinPath`, `getProcessEnv` from ts-runtime (the `process.platform`/`process.arch` defaults match laya-mlx). No drizzle. Rules in task 0085 enforce this.

**Handoff.** 0085 consumes `createFmDriver(options)` via dynamic import with `DecisionMakerOptions` passthrough; keep the export name and zero-arg default working.

### Plan

1. Scaffold `packages/decision-fm` from laya-mlx (manifest, tsconfigs, LICENSE, NOTICE, README skeleton, empty barrel); `bun install`; confirm `bun run build` and `bun run lint` include it (R1).
2. TDD `schema.ts`: x-order, enums, score string levels, required keys (R3).
3. TDD `estimate.ts`: frequencies, tie-breaks, entropy confidence, noul, k=1 one-hot (R6).
4. TDD `fm-process.ts` with a stub executor: argv for count-tokens/respond/available, prompt positional, `-g`, `--guardrails`, error table rows, ENOENT (R4, R5, R7, R8).
5. TDD `driver.ts`: prerequisite ordering, model/option validation, temp-file cleanup on success and failure, estimator declaration (R2, R8, R9).
6. Add host-conditional live tests (R10); finish README (R11).
7. `npm pack --dry-run` in the package; `bun run spur-check`; `bun run build`.

### Solution

Implemented `packages/decision-fm` as `@gobing-ai/ts-decision-fm@0.5.2` (R1–R11). 56 tests pass; live tests run only on darwin/arm64 with the system model available.

**Files created (all under `packages/decision-fm/` unless noted)**
- `package.json`, `tsconfig.json`, `tsconfig.build.json` — laya-mlx scaffold minus `worker`/`parity`; deps `ts-ai-runner` + `ts-runtime` as `workspace:*`; tsconfig paths mirror laya-mlx per ADR-004/012.
- `LICENSE` (copied verbatim), `NOTICE` (same format, minus the laya-mlx derivation paragraph — this package bundles no third-party code/weights, per design § Package).
- `src/schema.ts:19` — `FM_INSTRUCTIONS` (never mentions confidence); `src/schema.ts:35` — `buildFmSchema` with root `x-order` = all keys, `required`, `additionalProperties: false`; choice → label enum, score → `"0"…"n-1"` string enum, noul → `["yes","no"]` (R3, AC5); `src/schema.ts:86` — `buildPrompt` (state text + one block per question key with options/descriptions); plus `declaredOptions`/`formatDesc`.
- `src/estimate.ts:28` — `estimateChoice`, `src/estimate.ts:60` — `estimateScore`, `src/estimate.ts:96` — `estimateNoul`, `src/estimate.ts:14` — `entropyConfidence` (`1 − H(p)/ln(n)`): frequencies over all declared options with unsampled = 0, argmax with declaration-order / lower-level tie-break, noul = bare yes-probability (R6).
- `src/fm-process.ts:22` — `countTokensArgv`; `src/fm-process.ts:26` — `respondArgv` (`--no-stream --schema <f> -i <instr> [--guardrails g] [-g] <prompt>` positional last); `src/fm-process.ts:49` — `availableArgv`; `src/fm-process.ts:69` — `probeFmAvailability`; `src/fm-process.ts:84` — `countPromptTokens`; `src/fm-process.ts:119` — `runFmRespond` with the full § Errors mapping (`src/fm-process.ts:137` context-size → `DecisionRequestError`, `src/fm-process.ts:140` guardrails → `DecisionBackendError`, spawn failure → `DecisionConfigError` "fm not found", timeout → `DecisionTimeoutError(msg, timeoutMs)`); `src/fm-process.ts:154`/`:177` — `parseFmRespond`/`requireEnumValue` (R4, R5, R7).
- `src/driver.ts:70` — `createFmDriver` with `name: 'fm-local'` and declared `estimator` (`src/driver.ts:106`, R2); options per design § Main export (`src/driver.ts:37`); platform check at construction without spawning (`src/driver.ts:88`, R8); cached `fm available` probe on first ask (`src/driver.ts:98`, `:146`); count-tokens pre-flight, over budget → `DecisionRequestError` naming both numbers before any respond (`src/driver.ts:153`, R4/AC6); schema written to `joinPath(TMPDIR ?? '/tmp', fm-schema-<uuid>.json)` and deleted in `finally` (`src/driver.ts:163`); k sequential samples, one failure rejects the whole ask (`src/driver.ts:170`); per-kind estimation; model/option validation before any spawn (R9).
- `src/index.ts` — barrel.
- `tests/schema.test.ts` (9 tests), `tests/estimate.test.ts` (10), `tests/fm-process.test.ts` (15), `tests/driver.test.ts` (19, incl. AC2 substitution into `createDecisionMaker`, temp-file cleanup on success and failure, all-or-nothing sampling), `tests/live.test.ts` (3, `test.skipIf` gated on darwin/arm64 + probe exit 0; covers choice/score/noul, real-schema acceptance, deterministic one-hot) (R10).
- `README.md` — prerequisites, options table, estimator semantics (agreement not calibration, 1/k resolution, deterministic one-hot), latency ~0.3 s × k, error table, testing story (R11).
- `bun.lock` (root) — workspace entry added by `bun install` so the monorepo picks the package up.

**Key decisions**
- Followed the refine corrections exactly: prompt/instructions as final positional argv (no stdin seam in `ProcessExecutor`); `arch` option added next to `platform` with `process.platform`/`process.arch` defaults; temp path `TMPDIR ?? '/tmp'` + `crypto.randomUUID()`; spawn absence observed via the `available` probe (executor returns `outcome: 'error'` results — `run()` does not reject — mapped to `DecisionConfigError` "fm not found").
- Error classes use the real constructor signatures from `packages/ai-runner/src/decision/errors.ts`; `status` left `undefined` (local process).
- Live test gate mirrors `packages/ai-runner/tests/fm-live.test.ts` (top-level probe + `test.skipIf`); transcript-resume coverage stays in the ai-runner live suite (0083) — the agent shim is not part of this package.

**Verification evidence**
- `bun test packages/decision-fm` → 56 pass / 0 fail (stubbed suite platform-independent; live suite executed on this darwin host where `fm available --model system` exits 0, skips elsewhere).
- `bun run lint` (root; Biome `--error-on-warnings` + per-package `tsc --noEmit`) → exit 0, `ts-decision-fm typecheck: Exited with code 0`.
- `bun run build` (root) → all packages exit 0 incl. `ts-decision-fm`.
- `npm pack --dry-run` in `packages/decision-fm` → tarball lists `dist/`, `src/`, `README.md`, `LICENSE`, `NOTICE`, `package.json` only — no `tests/`, no `worker/` (task-local check satisfied).
- Nothing committed or staged; no edits outside `packages/decision-fm/` + `bun.lock`.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | package.json:3 locks 0.5.2 with root, package.json:54-55 workspace:* deps, package.json:35-41 files field, tsconfig.json:4-14 paths per ADR-004/012, bun.lock:51-57 registered, LICENSE Apache-2.0 and NOTICE adapted from laya-mlx — matches design § Package and R1 |
| R2 | MET | driver.ts:59-65 FmDecisionDriver with name fm-local and sample-frequency estimator, driver.ts:70-86 the nine options with design defaults, driver.test.ts:82-91 asserts no choice/score/noul sugar |
| R3 | MET | schema.ts:35-67 one object schema with x-order/required/additionalProperties false and string enums, driver.ts:163 unique temp file under getProcessEnv().TMPDIR ?? '/tmp', driver.ts:201-203 finally deletion incl. failure, driver.test.ts:196-217 and 330-338 |
| R4 | MET | fm-process.ts:85-110 count-tokens -q -i parses the bare integer, driver.ts:152-158 rejects over budget with a DecisionRequestError naming both numbers before any respond, driver.test.ts:159-193 covers over-budget and at-budget boundary |
| R5 | MET | fm-process.ts:27-48 respond argv with --no-stream --schema -i optional guardrails -g and prompt positional last, driver.ts:170-183 k sequential samples read by key via parseFmRespond fm-process.ts:155-189, fm-process.test.ts:55-93 pins argv shape |
| R6 | MET | estimate.ts:28-58 choice frequencies with declaration-order tie, estimate.ts:60-94 score with lower-level tie and legend, estimate.ts:96-99 noul bare probability, estimate.ts:14-25 confidence 1−H/ln n, estimate.test.ts:5-72 verifies all rows incl. k=1 one-hot |
| R7 | MET | fm-process.ts:70-189 maps every design error-table row (spawn ENOENT to Config, context marker to Request fm-process.ts:138-140, guardrails to Backend fm-process.ts:141-143, timeout to Timeout fm-process.ts:123-128, enum violation fm-process.ts:178-189), fm text carried via fmText fm-process.ts:46-51, driver.test.ts:300-310 proves one failed sample fails the whole ask with no retry |
| R8 | MET | driver.ts:87-94 platform/arch rejected at construction with zero spawns, driver.ts:96-103 probe fm available --model system (never bare, fm-process.ts:50-52) cached per driver, driver.test.ts:98-107 and 132-157 |
| R9 | MET | driver.ts:118-121 model limited to undefined or system, driver.ts:127-139 option counts from labels/rubric/binary-noul, driver.ts:141-144 empty map, driver.test.ts:109-130 all with zero calls asserted |
| R10 | MET | tests/driver.test.ts:74-77 pins darwin/arm64 with injected stub executor (53 stubbed tests across 4 files), live.test.ts:14-27 gates the 3 live tests on darwin/arm64 plus a real probe exit 0 via skipIf with the gating reason in the describe title |
| R11 | MET | README.md:19-32 host prerequisites, README.md:94-115 estimator semantics stating agreement-not-calibration and the 1/k resolution limit, README.md:117 latency ~0.3 s × k, options table matches design § Main export |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC-1 | MET | command | package.json:2-41 and bun.lock:51-57 satisfy name/version/deps/files; dist/ artifacts present proving the build ran in this worktree |
| AC-2 | MET | test | driver.ts:59-65 implements DecisionDriver; driver.test.ts:320-327 substitutes into createDecisionMaker and asserts per-kind answers |
| AC-3 | MET | test | estimate.ts:14-99 all probabilities from counts/k; schema.test.ts:35-40 and 45-49 prove no confidence field in schema or instructions |
| AC-4 | MET | test | driver.test.ts:93-96 and 271-281: exactly one respond with -g, one-hot probabilities, confidence 1 |
| AC-5 | MET | test | schema.ts:35-67 builds x-order/required/enums; schema.test.ts:6-33; live.test.ts:65-71 proves a real fm accepts the schema |
| AC-6 | MET | test | driver.ts:152-158 ordering puts the budget check before the sampling loop; driver.test.ts:159-193 asserts DecisionRequestError naming 7001 and 6000 |
| AC-7 | MET | test | fm-process.ts:70-189 full error-table mapping with fm text; fm-process.test.ts:96-200 and driver.test.ts:300-318 cover every row incl. no-answer-on-refusal |
| AC-8 | MET | test | driver.ts:87-94 construction-time host check; driver.ts:96-103 probe-before-sample; driver.test.ts:98-107,132-146 assert DecisionConfigError with zero spawns |
| AC-9 | MET | test | live.test.ts:14-27 skipIf gate with runtime probe; the host-independent stubbed suite (injected platform/executor, no fm dependency) executed in the recorded gate (2457 tests / 215 files) and the live subset executed gated on this darwin/arm64 host; Linux execution itself is exercised by the same stubbed suite via injected platform |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

<!-- spur:record-review -->

**SECU findings** (pipeline verify step — verdict: PASS)

| Priority | Dimension | Location | Finding |
|----------|-----------|----------|----------|
| P4 | spur task check | — | task check passed |
| P4 | evidence-rule-pass | — | All behavior-bearing AC rows have executable evidence or are explicitly non-behavioral. |
| P4 | proof-input-digest | — | sha256:efe2f6d79436e76cdf572c90b053bffc376018cf83f500cebae012c3e09275e6 |

### References

- Feature K; ADR-029/030 (`docs/00_ADR.md`); docs/design/decision-fm-backend.md.
- Template package: packages/laya-mlx (`src/driver.ts`, `src/worker-client.ts:118`, `package.json`).
- Error classes: packages/ai-runner/src/decision/errors.ts. Release bootstrap: docs/PACKAGE_RELEASE.md.
- Downstream: task 0085 (selector + rules).

### History

- 2026-09-23T18:32:56.944Z todo → wip (system)
- 2026-09-23T19:11:19.304Z wip → testing (system)
- 2026-09-23T19:11:19.639Z testing → done (system)

