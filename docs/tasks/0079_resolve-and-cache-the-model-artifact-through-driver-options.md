---
schema_version: 1
name: Resolve and cache the model artifact through driver options
status: done
template: feature-impl
created_at: 2026-09-21T03:11:42.100Z
updated_at: "2026-09-21T18:10:04.675Z"
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
| R1 | MET | Default model id `convaiinnovations/laya-multilingual` resolved at `worker-client.ts:488`; worker fetches into cache on first start; test `artifact-resolution.test.ts:8` |
| R2 | MET | `cacheDir` forwarded as `--cache-dir` :487,498 and exported as `HF_HUB_CACHE` before runtime import `laya_worker.py:105-106`; second driver starts from the cached copy — test `artifact-resolution.test.ts:23` |
| R3 | MET | `modelPath` takes precedence: `--model-path` pushed, `--model` suppressed `worker-client.ts:486,490-494`; test :56 (no fetch attempted) |
| R4 | MET | `modelPath` passed verbatim :490-491, never written/mutated by the client; test :56,:74 |
| R5 | MET | All defaults read from `options.env` allowlist only (`worker-client.ts:26,478-498`); no `process.env` access in package src; test :96 |
| R6 | MET | Cached-weights offline answer with zero HTTP: test `artifact-resolution.test.ts:116` 'answers a choice question from cached weights with no HTTP requests' (fresh pass); the decision path is a child process, no decision-service HTTP exists to call |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| R8 — The package resolves and caches the model artifact on the caller's behalf | MET | test | Fresh `bun test` (47 pass / 0 fail): artifact-resolution.test.ts:8 (default id), :23 (cache reuse across drivers), :56/:74 (explicit path precedence, verbatim) |
| R2 — A decision is answered from the Laya multilingual weights with no network call | MET | test | artifact-resolution.test.ts:116 — choice answered from cached weights with no HTTP issued; live counterpart: provisioned-host parity run (`bun run parity`) drives the same worker offline after one-time cache fill |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

<!-- spur:record-review -->

**SECU findings** (pipeline verify step — verdict: PASS)

| Priority | Dimension | Location | Finding |
|----------|-----------|----------|----------|
| P4 | spur task check | — | task check passed |
| P4 | tests-pass | — | `bun test` packages/laya-mlx: 47 pass / 0 fail (this run) |
| P4 | design-conformance | — | Resolution/caching driven through the worker with HF_HUB_CACHE set pre-import, as designed |
| P4 | evidence-rule-pass | — | All behavior-bearing AC rows have executable evidence or are explicitly non-behavioral. |

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-09-21T06:48:04.543Z todo → wip (system)
- 2026-09-21T06:49:14.770Z wip → testing (system)
- 2026-09-21T06:49:15.267Z testing → done (system)

