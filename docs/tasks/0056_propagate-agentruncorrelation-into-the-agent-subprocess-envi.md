---
template: standard
schema_version: 1
name: Propagate AgentRunCorrelation into the agent subprocess environment
description: ""
status: done
type: task
profile: standard
parent_wbs: null
priority: P1
tags: []
dependencies: []
created_at: 2026-07-31T06:12:41.145Z
updated_at: 2026-07-31T07:03:52.694Z
---

## 0056. Propagate AgentRunCorrelation into the agent subprocess environment

### Background
`AiRunner` already accepts an application-owned execution identity and already has a fully-plumbed
channel for passing environment variables to the agent subprocess. It just never connects the two.
Consequently a nested agent process cannot tell which run it belongs to — or that it is nested at
all — and downstream tooling is forced into wall-clock guesswork.

#### The gap, in three facts

1. **The identity exists.** `AgentRunOptions.correlation?: AgentRunCorrelation`
   (`packages/ai-runner/src/ai-runner.ts:40`) carries `runId`, `executionId`, and optional
   `actionId` — explicitly described in-source as "application-owned execution identity carried
   without coupling the runner to a workflow model".
2. **The channel exists.** `ProcessOptions.env?: Record<string, string>`
   (`packages/runtime/src/process-executor.ts:30`) is forwarded to the spawn on every code path
   (`:198`, `:310`, `:545`, `:577`, `:606`).
3. **Nothing connects them.** `ai-runner.ts` contains **zero** references to `env`. `invoke()`
   (`:158-182`) emits the correlation to the event bus (`agent.invoke.start`, `:167-172`) and then
   calls `processExecutor.run({ command, args, label, rejectOnError, forceBuffered, cwd, timeout,
   signal?, onOutput? })` — no `env` key. The correlation reaches observers but never reaches the
   child.

#### Why this matters downstream

Spur's `sp` plugin registers a `SessionStart` hook that records one ledger session per host session.
Because `agent.run` spawns nested subprocesses that each fire `SessionStart`, and because the child
has no way to learn it is nested, every nested fire used to mint a fresh session id, append a
`session_start` row, and overwrite the pointer file the `PostToolUse` hook reads. Evidence from one
project's ledger over 18 days: **332 `session_start` against 157 `session_end`** — a 2:1 imbalance
no real session pattern produces — across **298 distinct session ids**, with **39 starts in a
2-day window** that contained a handful of actual sessions.

Spur shipped a mitigation (task `0398` R3): treat an existing `.session.json` as in-flight if its
timestamp is within a 4-hour idle window. That is a wall-clock heuristic with a stated ceiling —
two genuinely distinct sessions started inside the window merge into one. It is marked in-source as
such, with this ts-libs change named as the upgrade path:

> *"The host gives hooks no session identifier, and the hook runs as a short-lived subprocess whose
> own pid says nothing about the agent's, so exact ancestry is not observable here."*

An inherited correlation in the child environment replaces that guess with an exact signal.

#### Provenance

Surfaced while implementing Spur task `0398` (feature `H7`), the remediation of a dogfood batch that
ran ~20 h for 6 small tasks. Design option 1 for `0398` R3 was "key on an ancestor-session env
marker"; that option was investigated, found unavailable for exactly the reason above, and the
weaker option 2 shipped instead. This task removes the reason.
### Requirements
R1. **`AiRunner.invoke` must forward the run correlation into the agent subprocess environment.** When `options.correlation` is present, `packages/ai-runner/src/ai-runner.ts:173-182` must include an `env` key in the `processExecutor.run({...})` call carrying `runId`, `executionId`, and `actionId` when set. The `ProcessOptions.env` channel already exists and is already forwarded to the spawn — this is a missing connection, not new plumbing.

R2. **The child environment must be extended, not replaced.** The forwarded variables must be additive to `process.env`. execa `9.6.1` defaults `extendEnv: true`, so passing `env` merges — but this is load-bearing and currently unasserted: a regression to `extendEnv: false` would strip `PATH`, `HOME`, and every provider credential from the child and break all agent invocation. Add a test that pins merge semantics, not just presence.

R3. **Variable names must be namespaced, stable, and documented.** Pick one prefix and treat the names as a public contract from the moment they ship — external hooks will key on them and cannot be refactored in lockstep. Suggested: `SPUR_RUN_ID`, `SPUR_EXECUTION_ID`, `SPUR_ACTION_ID`. If a vendor-neutral prefix is preferred (the package is `@gobing-ai/ts-ai-runner`, not Spur-specific), decide once and record the reason in `### Design` — do not ship both spellings.

R4. **Absent correlation must change nothing.** When `options.correlation` is `undefined`, no correlation variables are set and the `env` key is omitted entirely, matching the existing conditional-spread idiom used for `signal` and `onOutput` at `:180-181`. Existing callers that never pass a correlation must see byte-identical spawn options.

R5. **A nested invocation must be distinguishable from a top-level one.** The consumer's actual question is "am I a child of a run?", which the presence of an inherited `SPUR_RUN_ID` answers. Because `extendEnv` propagates the parent's variables transitively, a grandchild inherits the same values — decide and document whether that is intended (one id per run, all descendants share it) or whether depth must be distinguishable, and if so how. State the choice; do not leave it implicit.

R6. **No secrets in the forwarded environment.** Only the correlation identifiers may be added. Do not forward tokens, keys, prompts, or user content. Correlation ids are opaque identifiers and must remain so.

R7. **Unit tests assert the spawn options, not the observable side effects.** Use the injectable `processExecutor` (`AiRunnerOptions.processExecutor`, `ai-runner.ts:53`) with a recording double, and assert the `env` passed to `run()`: present with correct values when a correlation is supplied, absent when it is not, and merge-preserving per R2.

R8. **No regression in the existing suite.** Establish the pre-change baseline for the ai-runner and runtime packages before judging results; report the delta rather than an absolute count.

R9. **(Investigation, confidence LOW — may hand back.)** Determine what dominates `spur` CLI cold start. `spur task resolve` measured **2.40 s** against a `bun -e ''` floor of 1.41–2.00 s on the same box, so roughly 0.4–1.0 s is the CLI's own module graph. Whether that is the `@gobing-ai/ts-*` dependency graph, Spur's own code, or neither is **unverified**. Profile module load (e.g. `bun --inspect` or timed import probes) and attribute it. If the cost is not in these packages, close this requirement with the finding and hand it to the Spur repo — do not manufacture an optimisation here to justify the requirement. Every downstream consumer pays this on every CLI invocation, so the attribution is worth knowing either way.
### Acceptance Criteria
Scenario-to-requirement map: forward→R1 · merge→R2 · naming→R3 · absent→R4 · nesting→R5 ·
secrets→R6 · spawn-options→R7 · suite→R8 · attribution→R9.

```gherkin
Feature: Agent run correlation reaches the subprocess environment

  Scenario: A correlated invocation exports the run identifiers
    Given an AiRunner with a recording process executor
    When an agent is invoked with a correlation carrying runId and executionId
    Then the spawn options include an env entry for the run id
    And an env entry for the execution id

  Scenario: An optional action id is exported only when present
    Given an AiRunner with a recording process executor
    When an agent is invoked with a correlation that omits actionId
    Then no action id variable is present in the spawn options
    And the run id and execution id are still present

  Scenario: The child environment extends rather than replaces the parent
    Given a process executor that reports the environment the child would receive
    When an agent is invoked with a correlation
    Then the correlation variables are present
    And variables inherited from the parent process are still present

  Scenario: An uncorrelated invocation is unchanged
    Given an AiRunner with a recording process executor
    When an agent is invoked with no correlation
    Then the spawn options carry no env key
    And the spawn options are otherwise identical to the pre-change shape

  Scenario: A nested invocation can be distinguished from a top-level one
    Given a process running with an inherited run id in its environment
    When it inspects its own environment
    Then it can determine that it is a descendant of an agent run
    And the documented nesting semantics state whether descendants share one id

  Scenario: No secret material is added to the environment
    Given an agent invocation carrying a correlation
    When the spawn options are inspected
    Then the only added variables are the correlation identifiers
    And no token, key, prompt, or user content appears among them

  Scenario: The existing suite shows no new failures
    Given the pre-change baseline for the ai-runner and runtime packages
    When the suites are run after the change
    Then every previously passing test still passes
    And the only failures are the ones present in the baseline

  Scenario: CLI cold-start cost is attributed to a named owner
    Given a profile of module load time for the spur CLI entry point
    When the cost is broken down by package
    Then the dominant contributor is identified by name
    And the finding records whether it belongs to these packages or is handed back
```
### Q&A
**Q: Why does a generic agent-runner package carry a `SPUR_*` env contract?**
It does not have to — R3 leaves the prefix open and `### Design` argues both sides. The pragmatic
case for `SPUR_*` is that the hooks which will read these variables already read `SPUR_AGENT` and
`SPUR_MODEL` from the same environment, and a resolver that keys on two vocabularies for one concept
is worse than a vendor prefix in a package name. The principled case for a neutral prefix is real.
Decide once, record it, ship one spelling.

**Q: Is the correlation guaranteed present?**
No — `AgentRunOptions.correlation` is optional and many callers omit it. That is why R4 requires the
absent case to be byte-identical to today. This change makes correlation *useful* when supplied; it
does not make it mandatory, and it must not start warning about its absence.

**Q: Could the downstream hook use the process tree instead of an env var?**
That was tried and rejected in the consumer. The hook runs as a short-lived subprocess spawned by
the host, so its own pid says nothing about the agent's, and walking `ppid` is both platform-specific
and racy against a parent that exits first. Environment inheritance is the only channel that crosses
the boundary reliably and is scoped to exactly the right subtree.

**Q: Why is R9 in this task if it might not belong to this repo?**
Because the measurement points here first — `spur task resolve` costs ~2.4 s against a `bun -e ''`
floor of 1.4–2.0 s, and the `@gobing-ai/ts-*` graph is the largest thing the CLI imports. That is a
hypothesis, not a finding, and R9 is written so that disproving it is a successful outcome. It sits
here so the question gets *answered* rather than repeatedly rediscovered; if the answer is "not us",
the requirement closes with that sentence and moves to Spur.

**Q: Should `doctor-runner` and `team-agent-process` get the same treatment?**
Unresolved on purpose — the Plan asks for an explicit decision. Both spawn independently of
`invoke()`. `team-agent-process` plausibly wants correlation (it is long-lived work under a run);
`doctor` plausibly does not (it is a readiness probe with no run context). Whoever implements this
should look and state the call rather than silently covering one path.

**Q: How will we know this actually worked?**
Not from a green suite. The acceptance signal is downstream: Spur task `0398` R3 deletes
`SESSION_REUSE_IDLE_MS`, its 4-hour window, and the `ponytail:` comment naming the ceiling, and
replaces `resolveActiveSession` with an inherited-id test. Until that deletion happens, this change
is plumbing nobody is using.
### Design
#### The change

One conditional spread, matching the idiom already used two lines below for `signal` and `onOutput`
(`ai-runner.ts:180-181`):

```ts
const correlationEnv = options.correlation === undefined
    ? undefined
    : {
          SPUR_RUN_ID: options.correlation.runId,
          SPUR_EXECUTION_ID: options.correlation.executionId,
          ...(options.correlation.actionId !== undefined
              ? { SPUR_ACTION_ID: options.correlation.actionId }
              : {}),
      };

const result: ProcessResult = await this.processExecutor.run({
    command: command.command,
    args: command.args,
    label,
    rejectOnError: false,
    forceBuffered,
    cwd: options.cwd ?? this.defaultCwd,
    timeout: options.timeout ?? this.defaultTimeout,
    ...(correlationEnv !== undefined ? { env: correlationEnv } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.onOutput !== undefined ? { onOutput: options.onOutput } : {}),
});
```

Nothing in `runtime` needs to change — `ProcessOptions.env` is already declared (`:30`) and already
forwarded on every path (`:198` buffered, `:310` / `:545` / `:577` / `:606` streaming and helpers).

#### Merge semantics are the risk, not the feature

`buildExecaOptions` passes `env` straight through and sets no `extendEnv`. execa `9.6.1` defaults it
to `true` ("*Unless the `extendEnv` option is `false`, the subprocess also uses the current process'
environment variables*" — installed `types/arguments/options.d.ts:75`), so a partial `env` object
merges rather than replaces.

That default is doing critical work and nothing currently asserts it. If it ever flipped, every
agent subprocess would launch without `PATH`, `HOME`, or provider credentials — a total outage
that no existing test would catch, triggered by a dependency bump rather than a code change. R2
exists to pin it. Assert the merge, not just the presence of the new keys.

#### Naming is a public contract

The moment these variables ship, external hooks key on them. They cannot be renamed in lockstep
with consumers, so choose once:

- **`SPUR_*`** — matches the first consumer and the existing `SPUR_AGENT` / `SPUR_MODEL` /
  `SPUR_PROVENANCE_OVERRIDE` family that Spur's hooks already read. Cost: a vendor name in a
  vendor-neutral package.
- **A neutral prefix** (`AGENT_RUN_*`, `TS_AI_RUNNER_*`) — cleaner layering. Cost: Spur's hooks
  must learn a second vocabulary, and the package gains a name nobody else uses either.

Recommendation: **`SPUR_*`**, on the grounds that the existing `SPUR_AGENT` / `SPUR_MODEL` hints are
already read by the same hooks that will read these, and a split vocabulary in one `.session.json`
resolver is worse than a vendor prefix. Record whichever is chosen and why — R3 forbids shipping
both spellings.

#### Nesting semantics — decide explicitly

Because `extendEnv` propagates transitively, a grandchild inherits the same `SPUR_RUN_ID` as a
child. Two readings, and the consumer needs to know which:

- **One id per run, shared by all descendants** (simplest, and what the downstream `SessionStart`
  consumer actually wants — "am I inside *a* run?"). Depth is not observable.
- **Depth-aware**, e.g. an incremented `SPUR_RUN_DEPTH`. More information, more contract, and no
  current consumer.

Recommendation: ship the first, document that descendants share one id, and add depth only when
something needs it. R5 requires the choice be stated, not that a particular one be taken.

#### Why the downstream consumer needs this

Spur's `resolveActiveSession` currently answers "is a session already in flight?" with a 4-hour
wall-clock window, because the hook subprocess has no inherited identity to read. With an inherited
`SPUR_RUN_ID` it becomes an exact test — the heuristic and its documented ceiling (two distinct
sessions inside the window merge) can be deleted rather than tuned. That is the payoff; this change
is small precisely because the hard part was already built.

#### Rejected

- **Adding a bespoke `correlationEnv` option to `AgentRunOptions`.** The correlation is already
  there; a second way to say the same thing invites the two drifting apart.
- **Emitting only to the event bus and having consumers subscribe.** The consumer is a short-lived
  hook subprocess with no bus connection — the environment is the only channel that crosses the
  process boundary.
- **Writing a marker file instead.** Requires a location convention, a cleanup story, and a
  staleness rule — all of which the environment gets for free and correctly scoped to the process
  tree.
### Plan
R1-R8 are one small, self-contained change. R9 is an independent investigation and can be done
first, last, or by someone else.

#### Decide before coding

- [ ] Pick the variable prefix (R3) — `SPUR_*` recommended in `### Design`. Record the reason.
- [ ] Pick the nesting semantics (R5) — one shared id per run recommended. Record the reason.
      Both choices become public contract on ship; deciding them in the diff review is too late.

#### Implement (R1, R4)

- [ ] Build the correlation env object in `AiRunner.invoke`
      (`packages/ai-runner/src/ai-runner.ts:158-182`), conditional on `options.correlation`.
- [ ] Add the conditional `env` spread to the `processExecutor.run({...})` call, matching the
      existing `signal` / `onOutput` idiom at `:180-181`.
- [ ] Confirm no other `AiRunner` entry point bypasses `invoke` — `auth` routes through it (`:155`);
      check `doctor-runner.ts` and `team-agent-process.ts`, which spawn independently and may want
      the same treatment or may be deliberately out of scope. Decide and note which.

#### Test (R2, R6, R7)

- [ ] Recording double for `processExecutor` via `AiRunnerOptions.processExecutor` (`:53`); capture
      the `ProcessOptions` handed to `run()`.
- [ ] Correlation present → `env` carries run id + execution id; `actionId` appears only when set.
- [ ] Correlation absent → **no `env` key at all**, and the rest of the options object is unchanged
      (assert the whole shape, not just the absence — R4 is about byte-identical behavior for
      existing callers).
- [ ] **Merge semantics (R2)** — the one that protects against an outage. Assert that a parent
      variable survives alongside the injected ones. Prefer a real subprocess for this single case
      (spawn a tiny script that prints `process.env.PATH` and the correlation id): a mocked executor
      cannot catch an execa `extendEnv` default flipping, which is the exact regression this guards.
- [ ] Secrets (R6) — assert the injected key set is exactly the correlation identifiers.

#### Verify (R8)

- [ ] Baseline **first** on a clean tree, then compare: run the `ai-runner` and `runtime` package
      suites and record both numbers. Report the delta; do not quote an absolute pass count as
      evidence.
- [ ] Lint / typecheck / build per this repo's gate.
- [ ] Mutation-check the merge test: temporarily set `extendEnv: false` in `buildExecaOptions` and
      confirm the R2 test fails. If it still passes, it is asserting nothing. Revert.

#### Release + downstream

- [ ] Version bump and publish per this repo's convention — the consumer is a separate repository
      and cannot use an unpublished change.
- [ ] Document the variables (name, meaning, nesting semantics, stability expectation) wherever this
      package documents its public surface. Undocumented env contracts get broken.
- [ ] Hand back to Spur: task `0398` R3 can then replace `resolveActiveSession`'s 4-hour idle window
      with an exact inherited-id test, and delete `SESSION_REUSE_IDLE_MS` together with its
      `ponytail:` ceiling comment. That deletion is the real acceptance signal for this work.

#### R9 — cold-start attribution (independent, may hand back)

- [ ] Re-measure on a normal shell first; the quoted figures came from a restricted sandbox:
      `for i in 1 2 3; do /usr/bin/time -p spur task resolve <file>.md --strict --json >/dev/null; done`
      against `for i in 1 2 3; do /usr/bin/time -p bun -e '' 2>&1 | grep real; done`.
- [ ] If the gap between them is small, **stop and record that** — the premise dissolves and the
      cost is runtime startup, which is not this repo's problem.
- [ ] If the gap is real, attribute it: time the import graph of the CLI entry point and identify the
      dominant package by name.
- [ ] Write the finding either way, including "not us". A negative result that stops the next person
      re-deriving it is the deliverable; an invented optimisation is not.
### Solution
Implemented in `packages/ai-runner/src/ai-runner.ts`; zero runtime changes (the `env` channel was already forwarded on every spawn path).

**Change map**

- Exported three env-name constants (`packages/ai-runner/src/ai-runner.ts:72-76`): `AGENT_RUN_ID_ENV = 'SPUR_RUN_ID'`,
  `AGENT_EXECUTION_ID_ENV = 'SPUR_EXECUTION_ID'`, `AGENT_ACTION_ID_ENV = 'SPUR_ACTION_ID'`.
  Exported so tests and downstream consumers key on the symbol, not a string literal.
- Added `buildCorrelationEnv(correlation): Record<string, string>` helper (`packages/ai-runner/src/ai-runner.ts:85-91`)
  returning run+execution always, action conditionally.
- `invoke()` (`packages/ai-runner/src/ai-runner.ts:216-225`): builds `correlationEnv` (ternary, one line per biome), then
  conditionally spreads it as `env` via the same `...(x !== undefined ? { env: x } : {})` idiom
  already used for `signal` and `onOutput`.
- Doc comment (`packages/ai-runner/src/ai-runner.ts:49-71`) records the public env contract, nesting semantics, and prefix
  rationale (the WHY for `SPUR_*`: same hooks already read `SPUR_AGENT`/`SPUR_MODEL`).

**Design decisions (R3, R5)**

- Prefix `SPUR_*`: the first consumer is Spur's `SessionStart` hook, which already resolves
  `SPUR_AGENT`/`SPUR_MODEL` from the same environment. A split vocabulary in one resolver is worse
  than a vendor prefix in a vendor-neutral package name. One spelling shipped; both forbidden.
- Nesting: one shared id per run, all descendants share it. `extendEnv` propagates transitively, so
  a grandchild inherits the same `SPUR_RUN_ID`. Depth is not observable and no current consumer
  needs it; add `SPUR_RUN_DEPTH` only when something does.

**Scope decisions (doctor-runner / team-agent-process)**

- `doctor-runner`: out of scope. It is a readiness probe with no run context — forwarding
  correlation would be dead data.
- `team-agent-process`: documented follow-up. It already accepts caller-supplied `env`
  (`packages/ai-runner/src/team-agent-process.ts:10`), but its caller `TeamOrchestrator` does not thread correlation yet.
  Wiring it is a separate change in the orchestrator, not this runner fix.

**R2 — the load-bearing default**

`buildExecaOptions` (`packages/runtime/src/process-executor.ts:606`) sets no `extendEnv`, so execa 9.6.1's default `true`
applies: a partial `env` merges with `process.env`. Nothing asserted this. A regression to
`extendEnv: false` would strip `PATH`, `HOME`, and every provider credential from every agent
subprocess — a total outage triggered by a dependency bump. Now pinned by a mutation-checked test.

**R9 — cold-start attribution (disproven, handed back)**

Premise was that the `@gobing-ai/ts-*` graph dominates `spur` CLI cold start (~2.4 s measured in a
restricted sandbox). Re-measured on a normal shell: `bun -e ''` floor 0.00 s, `spur task resolve`
0.10–0.11 s. The ~2.4 s figure was the sandbox, not these packages — the gap dissolves to ~100 ms
of ordinary CLI startup. Requirement closes with "not us"; no optimisation belongs here.
### Testing
**Pipeline verify results** — re-audit via `/sp:dev-verify 0056 --force --focus all` on 2026-07-30 (task already `done`; supersedes the prior hollow `Verdict: UNKNOWN` entry, which recorded no evidence).

- Verdict: PASS
- Confidence: **HIGH** overall (R1–R8) — every cited line re-read and every gate re-run this turn (369 pass / 0 fail, tsc exit 0 ×2, biome clean, execa 9.6.1 resolved from disk). **MEDIUM** for R9's full causal story: the spur-vs-floor delta was re-measured this turn (HIGH for "not these packages"), but the original 2.4 s restricted-sandbox condition was not reproduced.
- Suites this run: `bun test packages/ai-runner packages/runtime` → **369 pass / 0 fail** (37 files); `bunx tsc --noEmit` exit 0 for `packages/ai-runner` and `packages/runtime`; `bunx biome check` clean on all changed files.
- Coverage: runtime change; suite ran under `bun test` coverage instrumentation — ai-runner.ts and process-executor.ts covered by the passing suites above.

**Per-Requirement Traceability**

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 forward correlation into subprocess env | MET | `packages/ai-runner/src/ai-runner.ts:216` (correlationEnv ternary) + `:225` (`...(correlationEnv !== undefined ? { env: correlationEnv } : {})` inside `processExecutor.run`), built by `buildCorrelationEnv` at `:85-91`; test `packages/ai-runner/tests/ai-runner.test.ts:176` — passed this run |
| R2 child env extends, not replaces (merge pinned) | MET | `packages/runtime/src/process-executor.ts:606` passes `env` straight through; zero `extendEnv` occurrences in `packages/runtime/src` (rg sweep), so execa **9.6.1** (installed version verified this run; manifest `^9.5.0`) default `extendEnv: true` applies; merge pinned by live-subprocess sentinel test `packages/runtime/tests/process-executor.test.ts:226` — passed this run |
| R3 namespaced, stable, documented names | MET | Single spelling `SPUR_RUN_ID` / `SPUR_EXECUTION_ID` / `SPUR_ACTION_ID` via exported constants `packages/ai-runner/src/ai-runner.ts:72-76`, public through the barrel (`packages/ai-runner/src/index.ts:5` `export * from './ai-runner'`); prefix rationale documented at `:49-71`; rg sweep found no alternate value-spelling in `packages/` |
| R4 absent correlation changes nothing | MET | `packages/ai-runner/src/ai-runner.ts:216` + `:225` conditional spread (same idiom as `signal`/`onOutput` at `:226-227`); test `ai-runner.test.ts:219` asserts `not.toHaveProperty('env')` and pins the remaining spawn-option shape — passed this run |
| R5 nested invocation distinguishable; semantics documented | MET | Presence of inherited `SPUR_RUN_ID` answers "am I inside a run"; nesting semantics (one id per run, shared by all descendants, depth not observable) documented at `ai-runner.ts:58-61` and in this task's Design §Nesting; transitive-inheritance mechanism executable-pinned by `process-executor.test.ts:226` |
| R6 no secrets in forwarded env | MET | `buildCorrelationEnv` (`ai-runner.ts:85-91`) forwards exactly three keys; test `ai-runner.test.ts:242` asserts the key set is exactly the three identifiers and that secret-looking prompt content does not appear — passed this run |
| R7 unit tests assert spawn options via recording double | MET | `FakeExecutor` recording double; assertions on `executor.calls[0].env` in `ai-runner.test.ts:176`, `:191`, `:219`, `:242` — all passed this run |
| R8 no regression vs pre-change baseline | MET | `git diff` verified additive-only: no pre-existing test modified or deleted in either test file, source change is one additive conditional spread; scoped suite this run 369 pass / 0 fail. Delta vs baseline: **+5 tests** (4 ai-runner, 1 runtime), all passing; pre-existing assertions untouched |
| R9 cold-start attribution (investigation; handed back) | MET | Closed with finding per the requirement's explicit hand-back clause: Solution §R9 records the 2.4 s figure as a restricted-sandbox artifact (re-measured `spur` ≈ 0.10–0.11 s vs `bun` floor ≈ 0.00–0.06 s). Independent spot-check this run: `spur --version` user 0.17 s ≈ bun floor + ~0.14 s — corroborates "not these packages"; no optimisation manufactured here |

**Acceptance Criteria Verification**

| AC | Status | Evidence Type | Evidence |
|----|--------|---------------|----------|
| Scenario: correlated invocation exports run identifiers | MET | test | `ai-runner.test.ts:176` — passed this run |
| Scenario: action id exported only when present | MET | test | `ai-runner.test.ts:191` — passed this run |
| Scenario: child environment extends the parent | MET | test | `process-executor.test.ts:226` (live `sh` subprocess, sentinel survives + forwarded var present) — passed this run |
| Scenario: uncorrelated invocation is unchanged | MET | test | `ai-runner.test.ts:219` (no `env` key; shape pinned) — passed this run |
| Scenario: nested invocation distinguishable + documented semantics | MET | test + static | mechanism: `process-executor.test.ts:226`; documented choice: `ai-runner.ts:58-61` |
| Scenario: no secret material added | MET | test | `ai-runner.test.ts:242` — passed this run |
| Scenario: existing suite shows no new failures | MET | command | `bun test packages/ai-runner packages/runtime` → 369 pass / 0 fail this run; diff additive-only |
| Scenario: CLI cold-start cost attributed to a named owner | MET | command | `time spur --version` vs `time bun -e ''` this run (delta ≈ 0.14 s); owner named: the restricted sandbox, not `@gobing-ai/ts-*` — handed back per R9 clause |

**Design Conformance**

| Check | Status | Evidence |
|-------|--------|----------|
| design-conformance | pass | 6/6 claims DONE after fix (conditional-spread idiom `:225`; zero runtime src changes — `git diff --stat` shows only `process-executor.test.ts` in runtime; single `SPUR_*` spelling recorded; one-id-per-run nesting documented; R2 merge pinned; change-map anchors now current). Initial audit found 1 CHANGED: stale Solution change-map anchors (constants cited `:45-47` → actual `:72-76`; `buildCorrelationEnv` `:49-58` → actual `:85-91`; doc comment `:51-66` → actual `:49-71`; `team-agent-process.ts:38` → `:10`) — **fixed this run** via `spur task update 0056 --section Solution` |

**SECUA Review** — focus: all. No blocker or major findings. Security: env values are caller-owned opaque ids, keys are constants, no shell interpolation on the spawn path (execa). Efficiency: one small object literal per invocation. Correctness: absent/conditional paths pinned by tests. Architecture: mapping lives at the runner seam; `ts-runtime` stays generic; no direct platform-API use (ADR-011/014 clean). Minor (P3): stale Solution change-map anchors — **fixed this run** (see design-conformance row).

**Fix pass (`--fix all`)**: no UNMET/PARTIAL requirements and no major findings to repair; the one minor finding (stale Solution change-map anchors) was corrected in `docs/tasks/0056_propagate-agentruncorrelation-into-the-agent-subprocess-envi.md` §Solution via `spur task update 0056 --section Solution`. Requirements/Design pre-implementation citations (e.g. R1's `:173-182`, Design's `:180-181`) intentionally left as-authored — they record where the change was directed pre-implementation; this Testing section carries the verified current anchors. Gitignored artifact written by this re-audit: `.spur/run/0056-verdict.json` (full machine verdict; `requirements[]`, `acceptanceCriteria[]`, `checks[]`, `confidence`).
### Review
## Findings

| Priority | Finding | Disposition |
| --- | --- | --- |
| P1 | None | — |
| P2 | First R2 test draft asserted on PATH surviving. PATH is an unreliable merge signal: Bun injects a minimal PATH even when extendEnv:false, so the assertion passed under the mutation it was meant to catch. Replaced with a process-local sentinel var; mutation-check now fails correctly under extendEnv:false. | Addressed — corrected before claiming done |
| P3 | team-agent-process does not yet thread correlation; its caller TeamOrchestrator must pass it. | Accepted as follow-up — documented in Solution, not done here to keep the runner fix self-contained |
| P4 | The SPUR_* env contract is now public; external hooks key on these names and cannot be renamed in lockstep. | Mitigated — name constants exported, stability expectation documented in doc comment |

## Residual risk

- `extendEnv: true` is an execa default, not an explicit setting. If a future execa major flips the default, the R2 test catches it — but only if the runtime test suite runs in CI. It does.

## Disposition

PASS. All nine requirements satisfied (R9 closes with a disproven-premise finding, as the requirement explicitly permits). The real acceptance signal is downstream — Spur task 0398 R3 can now delete SESSION_REUSE_IDLE_MS and replace resolveActiveSession's 4-hour window with an exact inherited-id test.
### References
#### Code sites in this repository

- `packages/ai-runner/src/ai-runner.ts:29-41` — `AgentRunOptions`, including
  `correlation?: AgentRunCorrelation`.
- `packages/ai-runner/src/ai-runner.ts:43-48` — `AgentRunCorrelation` (`runId`, `executionId`,
  optional `actionId`).
- `packages/ai-runner/src/ai-runner.ts:158-182` — `invoke()`, the function to change. Emits the
  correlation to the bus at `:167-172`; calls `processExecutor.run({...})` at `:173-182` with **no**
  `env` key. `rg -n env packages/ai-runner/src/ai-runner.ts` returns nothing — that is the gap.
- `packages/ai-runner/src/ai-runner.ts:180-181` — the conditional-spread idiom (`signal`,
  `onOutput`) the new `env` spread should match.
- `packages/ai-runner/src/ai-runner.ts:53` — `AiRunnerOptions.processExecutor`, the injection point
  for the test double.
- `packages/ai-runner/src/ai-runner.ts:155` — `auth` routing through `invoke`, so it inherits the fix.
- `packages/ai-runner/src/doctor-runner.ts` and `packages/ai-runner/src/team-agent-process.ts` —
  independent spawn paths; both already reference `env` (`doctor-runner.ts:130`,
  `team-agent-process.ts:38`). In scope or not is an open decision (see `### Plan`).
- `packages/runtime/src/process-executor.ts:25-45` — `ProcessOptions`, with `env?` at `:30`.
- `packages/runtime/src/process-executor.ts:194-204` — `runUntraced` → `buildExecaOptions({ env })`.
- `packages/runtime/src/process-executor.ts:310,545,577,606` — the other paths that forward `env`.

#### Dependency facts (verified from installed packages, not memory)

- `execa` `9.6.1` (`packages/runtime/package.json:62` declares `^9.5.0`).
- `extendEnv` defaults to **true** — installed
  `node_modules/.bun/execa@9.6.1/node_modules/execa/types/arguments/options.d.ts:75`: *"Unless the
  `extendEnv` option is `false`, the subprocess also uses the current process' environment
  variables."* Nothing in `process-executor.ts` sets `extendEnv`, so the default applies. R2 exists
  to pin this.

#### Downstream consumer (Spur, `~/xprojects/spur-new`)

- `plugins/sp/hooks/context-session-start.ts:35-94` — `resolveActiveSession` +
  `SESSION_REUSE_IDLE_MS`, the 4-hour wall-clock heuristic this change replaces. Its doc comment
  names the missing env marker as the reason it exists and this work as the upgrade path.
- `plugins/sp/hooks/context-session-stop.ts` — the symmetric teardown; deletes `.session.json`. A
  nested stop can still retire a live session, tracked separately in Spur.
- `plugins/sp/hooks/hooks.json` — `SessionStart` / `SessionEnd` wiring.
- `docs/tasks3/0398_fix-h6-dogfood-defects-hook-spawn-overhead-pipeline-agent-ru.md` — task 0398.
  `### Root Cause` RC-2 holds the ledger evidence (332 `session_start` vs 157 `session_end`, 298
  distinct ids, 39 starts in the 2-day H6 window); `### Design` § "R3 idempotency signal" states the
  preference order that made this the option-1 upgrade path.
- `docs/features/H7_h6-dogfood-remediation-*.md` — feature H7, scenarios R5/R6 are the behavior the
  exact signal would make deterministic.

#### Companion task

- `~/xprojects/superskill` — a sibling task removes an avoidable `spur task resolve` spawn from the
  `sp` write-guard hook (~2.4 s per file mutation). Related to R9 from the other side: that task
  stops *calling* the slow CLI, R9 asks *why* it is slow. Neither depends on the other.

#### Reproduce the downstream evidence

```bash
# session_start vs session_end imbalance in a project's ledger
jq -r 'select(.type=="session_start") | .ts[0:10]' .spur/context/token-ledger.jsonl | sort | uniq -c
jq -r '.type' .spur/context/token-ledger.jsonl | sort | uniq -c
jq -r '.session' .spur/context/token-ledger.jsonl | sort -u | wc -l
```

> Figures quoted throughout were measured inside a restricted agent sandbox on macOS. The structural
> claims (no `env` reference in `ai-runner.ts`; `ProcessOptions.env` forwarded on every path;
> `extendEnv` default true) were read from source and installed types and are environment-independent.
> The timing figures in R9 are not — re-derive them on a normal shell.
### History
- 2026-07-31T06:31:42.093Z backlog → todo (system)
- 2026-07-31T06:31:42.247Z todo → wip (system)
- 2026-07-31T06:31:42.546Z wip → testing (system)
- 2026-07-31T06:31:49.912Z testing → done (system)
