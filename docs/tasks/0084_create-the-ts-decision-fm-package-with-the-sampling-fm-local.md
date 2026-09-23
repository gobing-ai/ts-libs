---
schema_version: 1
name: Create the ts-decision-fm package with the sampling fm-local driver
status: todo
template: feature-impl
created_at: 2026-09-23T16:30:08.844Z
updated_at: "2026-09-23T17:08:03.085Z"
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

- [ ] R1. Scaffold `packages/decision-fm` as `@gobing-ai/ts-decision-fm` at the current lockstep version (0.5.2), deps `@gobing-ai/ts-ai-runner` + `@gobing-ai/ts-runtime` as `workspace:*`, tsconfig paths per ADR-004/012; `package.json`/`tsconfig*.json`/scripts mirror laya-mlx minus `worker` and the `parity` script; LICENSE and NOTICE copied.
- [ ] R2. Export `createFmDriver(options?: FmDriverOptions): FmDecisionDriver` with the exact shape in docs/design/decision-fm-backend.md § Main export: `name: 'fm-local'`, `estimator: { kind: 'sample-frequency'; samples; greedy }`; options `samples` (5), `deterministic` (false), `maxPromptTokens` (6000), `requestTimeoutMs` (30000), `guardrails`, `fmPath` ('fm'), `executor`, `platform`, `arch`.
- [ ] R3. One JSON schema per ask over the whole question map: root object with `x-order` listing every key, `additionalProperties: false`, all keys required; choice → string enum of labels, score → string enum `"0"…"n-1"`, noul → `["yes","no"]`. Written to a uniquely named temp file, deleted in `finally`.
- [ ] R4. Pre-flight `fm count-tokens -q -i <instructions> <prompt>`; a count above `maxPromptTokens` raises `DecisionRequestError` naming both numbers and no `fm respond` runs.
- [ ] R5. Sampling: `samples` sequential `fm respond --no-stream --schema <file> -i <instructions> [--guardrails <g>] <prompt>`; deterministic mode runs exactly one call with `-g`. Each stdout is parsed as JSON and read by key.
- [ ] R6. Estimation per design § Probability estimation: frequencies over all declared labels/levels (unsampled = 0), argmax with declaration-order / lower-level tie-break, `confidence = 1 − H(p)/ln(n)`; noul `{kind:'noul', probability: yes/k}`. Neither prompt nor schema contains a confidence field.
- [ ] R7. Error mapping per design § Errors table, every row; fm text is carried in the message; no refusal or malformed output becomes an answer.
- [ ] R8. Host prerequisites checked once per driver, before the first ask: non-darwin or non-arm64 ⇒ `DecisionConfigError` without spawning; then the `fm available --model system` probe per Background corrections.
- [ ] R9. `ask({ model })` accepts only `undefined` or `'system'`; anything else ⇒ `DecisionRequestError`. A question with fewer than two options ⇒ `DecisionRequestError`.
- [ ] R10. Tests: stubbed `ProcessExecutor` with `platform: 'darwin', arch: 'arm64'` pinned covers R3–R9; live tests run only when `process.platform === 'darwin'` and the availability probe exits 0.
- [ ] R11. README: prerequisites, options, estimator semantics (agreement, not calibration; 1/k resolution), latency cost (~0.3 s × k per ask).

Out of scope: `fm serve`, PCC models, parallel sampling, the `fm-local` selector in ts-ai-runner (task 0085), and the first npm publish (operator bootstrap per docs/PACKAGE_RELEASE.md). No `.github/workflows/` edit is needed — the root workspaces glob covers `packages/*`.

### Acceptance Criteria

- [ ] AC1 — The workspace publishes ts-decision-fm as a lockstep-versioned package
- [ ] AC2 — The fm driver satisfies the same DecisionDriver contract as the existing backends
- [ ] AC3 — Choice probabilities come from repeated samples and never from self-reported confidence
- [ ] AC4 — Deterministic mode answers with a single greedy sample
- [ ] AC5 — Every generated schema carries the property-order key that fm requires
- [ ] AC6 — An oversized question is rejected before the model is invoked
- [ ] AC7 — fm failures surface through the existing decision error taxonomy
- [ ] AC8 — Missing host prerequisites are reported before any decision is attempted
- [ ] AC9 — The test suites pass on Linux CI and exercise the live model only on capable hosts

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

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- Feature K; ADR-029/030 (`docs/00_ADR.md`); docs/design/decision-fm-backend.md.
- Template package: packages/laya-mlx (`src/driver.ts`, `src/worker-client.ts:118`, `package.json`).
- Error classes: packages/ai-runner/src/decision/errors.ts. Release bootstrap: docs/PACKAGE_RELEASE.md.
- Downstream: task 0085 (selector + rules).

### History
