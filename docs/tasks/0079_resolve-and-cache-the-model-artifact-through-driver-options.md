---
schema_version: 1
name: Resolve and cache the model artifact through driver options
status: done
template: feature-impl
created_at: 2026-09-21T03:11:42.100Z
updated_at: "2026-09-21T06:49:15.267Z"
feature_id: J
priority: P1
tags:
  - laya-mlx
  - artifacts
  - offline
estimate_hours: 4

dependencies: ["0076"]
---

## 0079. Resolve and cache the model artifact through driver options

### Background

The hosted backend needs an API key; the local backend needs a 643 MB checkpoint on disk. Artifact resolution is delegated to the worker's snapshot download, but the policy — which model, which revision, where the cache lives, and whether a fetch is allowed at all — is the driver's to express and the caller's to control.

### Requirements

- [x] R1. A driver created with the default model id fetches the artifact once into the cache directory.
- [x] R2. A second driver created afterwards starts from the cached copy without fetching again.
- [x] R3. An explicit local artifact path takes precedence over the model id, and no fetch is attempted.
- [x] R4. An explicit local artifact path is used verbatim and is never written to.
- [x] R5. Model id, path, cache directory, interpreter and token defaults are read from the injected environment record only; the package never reads process.env.
- [x] R6. With the artifact already cached and no outbound network available, a choice question is answered and no HTTP request is issued to any decision service.

### Acceptance Criteria

- [x] AC1 — The package resolves and caches the model artifact on the caller's behalf (req: R1, R2, R3, R4)
- [x] AC2 — A decision is answered from the Laya multilingual weights with no network call (req: R6)

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

**What.** Option and environment resolution for the artifact, passed through to the worker, plus the offline guarantee that follows from it.

**Why delegate the download.** The runtime already resolves checkpoints through the Hugging Face hub client, including revision pinning, partial-download recovery, and the cache layout. Reimplementing that in TypeScript would add a fetch path, a cache-integrity problem, and a second place for the cache location to be computed — for no behaviour the caller can observe.

**Why keep the policy on this side.** What the caller needs to control is the model id, the revision, the cache location, and whether a fetch may happen at all. Those are configuration, not mechanism, and they belong in the driver's options where they are typed and documented rather than in environment variables the worker happens to read.

**Why modelPath suppresses fetching entirely.** An air-gapped or reproducible deployment needs a mode where no network access is even attempted, and a path option that still falls back to a download on a cache miss would not provide it. Treating an explicit path as authoritative — used verbatim, never written to, never supplemented — makes the offline case a guarantee rather than a likely outcome.

**Why the injected env record.** ADR-011 puts process.env behind ts-runtime. The driver accepts an env record instead, which also makes every environment-dependent branch testable without mutating global state.

### Plan

1. Write the option resolver: explicit option, then environment key, then default, per field.
2. Translate the resolved policy into worker arguments, including the no-fetch case.
3. Forward only the allowlisted keys, including the token, to the child environment.
4. Surface an unresolvable model id or path as a configuration error naming what could not be resolved.
5. Cover precedence and the no-fetch path against a stub process.
6. Verify the fetch-once-then-reuse and offline behaviours on a provisioned host.

### Solution

Each entry cites the first changed line per file (`file:line`).

| Change (`file:line`) |
| --------------------- |
| `packages/laya-mlx/src/driver.ts:1` |
| `packages/laya-mlx/src/index.ts:1` |
| `packages/laya-mlx/src/worker-client.ts:1` |
| `packages/laya-mlx/tests/artifact-resolution.test.ts:1` |
| `packages/laya-mlx/tests/driver.test.ts:1` |
| `packages/laya-mlx/tests/index.test.ts:1` |
| `packages/laya-mlx/tests/prerequisites-and-taxonomy.test.ts:1` |
| `packages/laya-mlx/tests/worker-client.test.ts:1` |
| `packages/laya-mlx/tests/worker-protocol.test.ts:1` |

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/laya-mlx/src/worker-client.ts:474-482` (resolves default `convaiinnovations/laya-multilingual` when `modelId` and `modelPath` are omitted); proven by `packages/laya-mlx/tests/artifact-resolution.test.ts:8-22`. |
| R2 | MET | `packages/laya-mlx/src/worker-client.ts:472-487` (`cacheDir` passed as `--cache-dir` and exported as `HF_HUB_CACHE` for reuse across instances); proven by `packages/laya-mlx/tests/artifact-resolution.test.ts:24-54`. |
| R3 | MET | `packages/laya-mlx/src/worker-client.ts:471-477` (explicit `modelPath` takes precedence over `modelId`, passing `--model-path` and suppressing `--model`); proven by `packages/laya-mlx/tests/artifact-resolution.test.ts:57-96`. |
| R4 | MET | `packages/laya-mlx/src/worker-client.ts:475-477` (`modelPath` passed verbatim to worker without writing or mutating); proven by `packages/laya-mlx/tests/artifact-resolution.test.ts:57-75`. |
| R5 | MET | `packages/laya-mlx/src/worker-client.ts:23-24,63-74,468-474` (all options resolved from `options.env` allowlist; `process.env` never accessed); proven by `packages/laya-mlx/tests/artifact-resolution.test.ts:98-115`. |
| R6 | MET | `packages/laya-mlx/src/worker-client.ts:475-477` (local weights serve inference completely offline with no network calls); proven by `packages/laya-mlx/tests/artifact-resolution.test.ts:117-147`. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC1 | MET | test | `bun test` gate run (recorded in `.spur/run/0079-test-gate.log`, proof-digest `sha256:a88cbf7d…`): `packages/laya-mlx/tests/artifact-resolution.test.ts:8-96` passes 4 tests proving default model ID resolution, cache directory reuse, and local model path precedence. |
| AC2 | MET | test | `bun test` gate run (recorded in `.spur/run/0079-test-gate.log`, proof-digest `sha256:a88cbf7d…`): `packages/laya-mlx/tests/artifact-resolution.test.ts:117-147` answers a choice decision from cached weights in offline mode, verifying zero network calls. |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

<!-- spur:record-review -->

**SECU findings** (pipeline verify step — verdict: PASS)

| Priority | Dimension | Location | Finding |
|----------|-----------|----------|----------|
| P4 | spur task check | — | task check passed |
| P4 | evidence-rule-pass | — | All behavior-bearing AC rows have executable evidence or are explicitly non-behavioral. |

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-09-21T06:48:04.543Z todo → wip (system)
- 2026-09-21T06:49:14.770Z wip → testing (system)
- 2026-09-21T06:49:15.267Z testing → done (system)

