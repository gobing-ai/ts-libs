---
schema_version: 1
name: Add the fm text-only agent shim to ts-ai-runner
status: done
template: feature-impl
created_at: 2026-09-23T16:30:08.841Z
updated_at: "2026-09-23T18:25:11.668Z"
feature_id: K
priority: P1
tags:
  - ai-runner
  - fm
estimate_hours: 4

---

## 0083. Add the fm text-only agent shim to ts-ai-runner

### Background

Implements: R1 — ts-ai-runner detects the fm agent and reports its version without a version flag; R2 — Doctor reports fm model availability from the system-model probe; R3 — A prompt sent through the fm agent returns the model text response; R4 — A second fm prompt in the same session continues the saved transcript; R5 — The fm agent declares itself text-only and is never auto-selected for tool-using work; R16 — The test suites pass on Linux CI and exercise the live model only on capable hosts (ai-runner half). Design of record: ADR-031 and docs/design/decision-fm-backend.md § fm agent.

`fm` is Apple's on-device Foundation Model CLI (`/usr/bin/fm`, macOS 27, build `FoundationModels-2.0.68.1.402`). It is a plain LLM with no file or shell tools, so it joins the shim table as a prompt-only agent that downstream auto-selection (spur `agent-service.ts` iterates `TIER1_PRIORITY`) must never pick.

**Refine corrections (2026-09-23)**
- "version parsed as the FoundationModels build identifier" → `what -q /usr/bin/fm` prints `PROGRAM:fm  PROJECT:FoundationModels-2.0.68.1.402` three times (one per binary slice) and `AgentDetector` reports the first output line verbatim (`agent-detector.ts:84`) → no parsing added; the reported version is that line. Feature AC R1 reworded to "version line carries the build identifier".
- "doctor reports unavailable with the reason text" → `probeAuthOutput` returns only a tri-state and `DoctorResult` has no probe-text field (`doctor-runner.ts:16-49`) → doctor reports `unauthenticated`; the reason text moves to the ts-decision-fm prerequisite error (task 0084). Feature AC R2/R15 updated.
- "`TIER1_PRIORITY` drives auto-selection inside ts-ai-runner" → it has no consumer in this repo; the consumer is spur `packages/app/src/services/agent-service.ts:2188` → exclusion from the exported list is still the correct seam; the test asserts list membership.
- `probeAuthOutput` already returns `unauthenticated` on non-zero exit and tests the negative pattern before the positive one (`auth-shims.ts:174-177`), so `unavailable` never false-matches `available`.

### Requirements

- [x] R1. `AgentName` gains `'fm'`; `AGENT_SHIMS.fm` has `command: 'fm'`, `tier: 1`, help `fm --help`, version `what -q /usr/bin/fm`, auth `fm available --model system`.
- [x] R2. `getPromptCommand` returns `fm respond --no-stream [-m <model>] [session flags] <input>`; `mode` is ignored (no schema to pass through generic `PromptOptions`).
- [x] R3. Session argv: `sessionId` set → `--resume <f> --save-transcript <f>` where `<f>` = `joinPath(sessionDir, `${sessionId}.json`)`, or `${sessionId}.json` when `sessionDir` is unset; only `sessionDir` → `--save-transcript <sessionDir>/fm-session.json`; neither → no transcript flags; `continue` alone degrades to a fresh call. The shim does no filesystem I/O.
- [x] R4. `AgentShim` gains optional `readonly textOnly?: boolean`; `fm` sets `true`; no other shim sets it.
- [x] R5. `fm` is absent from `TIER1_PRIORITY` and `TIER2_AGENTS`, appended last in `DISPLAY_ORDER`; `resolveAgentName('fm') === 'fm'` and `isAgentName('fm')` is true.
- [x] R6. `AUTH_PATTERNS.fm = { positive: /System model available/i, negative: /unavailable/i }`.
- [x] R7. `AGENT_SESSION_CAPABILITY.fm = { supportsResumeById: true, supportsSessionDir: true, supportsPersistentStdin: false, supportsStructuredOutput: false, verifiedAgainst: 'FoundationModels-2.0.68.1.402', note }` with a note naming both gaps.
- [x] R8. Unit tests cover version/auth/prompt argv, every session branch, detector parse of the real `what` output, doctor row, and list membership; they pass on Linux without `fm`.
- [x] R9. One live test runs only when `process.platform === 'darwin'` and `fm available --model system` exits 0; it runs two prompts through `AiRunner` with a session and checks the second recalls the first.
- [x] R10. `packages/ai-runner/README.md` lists `fm` in the identifier list, the session table and the agent table, marked text-only.

Out of scope: a structured-output mode for the agent (belongs to ts-decision-fm), `fm chat`/`fm serve`, PCC models, any change to `AgentDetector` or `DoctorResult`.

### Acceptance Criteria

- [x] AC1 — ts-ai-runner detects the fm agent and reports its version without a version flag
- [x] AC2 — Doctor reports fm model availability from the system-model probe
- [x] AC3 — A prompt sent through the fm agent returns the model text response
- [x] AC4 — A second fm prompt in the same session continues the saved transcript
- [x] AC5 — The fm agent declares itself text-only and is never auto-selected for tool-using work
- [x] AC6 — The test suites pass on Linux CI and exercise the live model only on capable hosts

Task-local check: `bun test packages/ai-runner` passes on a host without fm.

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-09-23T16:36:15.820Z

- Closed: version string is the raw first `what` line (no detector change) — matches every other agent's reporting.
- Closed: doctor's unavailable reason is not carried in `DoctorResult`; ts-decision-fm (0084) surfaces it in its prerequisite error.
- Closed: session file for `sessionId` without `sessionDir` is `<sessionId>.json` relative to the run cwd.

### Design

**Approach.** Add one shim row and its registry entries in `packages/ai-runner/src/agents/shims.ts`, one `AUTH_PATTERNS` row in `src/agents/auth-shims.ts`. No new module, no change to `AgentDetector`, `DoctorRunner` or `AiRunner` — the generic paths already handle a non-`--version` command, non-zero exit ⇒ not installed, and first-line version reporting.

**Frozen names.** `AgentName` literal `'fm'`; `AgentShim.textOnly?: boolean` (doc: "Prompt-only LLM: no file-writing or shell tools. Callers dispatching tool-using work must refuse it."); transcript default file name `fm-session.json`; session file `<sessionId>.json`.

**Why `what -q`.** `fm --version` prints "Unknown option" and exits 0 (would parse no version); `what` reads the embedded SCCS build string and exits 1 when `/usr/bin/fm` is absent, so Linux/older macOS report `installed: false` through the existing non-zero-exit branch. The absolute path is deliberate: `fm` ships only there.

**Why `textOnly` on the shim.** It keeps capability metadata beside the command table that consumers already import (`getAgentShim`). Rejected: a separate `TEXT_ONLY_AGENTS` set (a seventh registry spot, cf. docs/plans/2026-06-04 F8); overloading `tier: 2` (tier means gateway/TUI-constrained, and doctor maps it).

**Sessions (ADR-047 R5).** A `sessionId`/`sessionDir` selects the scoped path and suppresses `continue`. A resume of a missing transcript makes `fm` exit 1 ("Unable to read transcript at …"); that failure surfaces as a failed run, never a silent fresh start. Checking the file in the shim would break purity.

**Anti-patterns.** Do not add fm to `TIER1_PRIORITY`; do not probe with bare `fm available` (exits 0 when unavailable); do not add `--schema` handling to `PromptOptions`; do not strip or reformat the `what` output in the detector.

**Handoff.** Independent of 0084/0085. 0084 reuses no code from this task; it owns its own fm invocation.

### Plan

1. Tests first in `packages/ai-runner/tests/agents/shims.test.ts` and `auth-shims` tests: argv for version/auth/help/prompt (R1, R2), every session branch (R3), `textOnly` only on fm (R4), membership in `TIER1_PRIORITY`/`DISPLAY_ORDER`/`TIER2_AGENTS` and resolution (R5), auth pattern tri-state incl. `System model unavailable: modelNotReady` ⇒ unauthenticated (R6), capability row (R7).
2. `tests/agent-detector.test.ts`: stub runner returning the real three-line `what` output ⇒ installed with that first line; exit 1 ⇒ not installed (R8).
3. Implement the shim row, `textOnly` field, registries, auth pattern and capability row until step 1–2 pass.
4. Add the live test guarded by `process.platform === 'darwin'` plus an `fm available --model system` probe, skipping with a stated reason otherwise (R9).
5. Update README sections (R10).
6. `bun run spur-check` and `bun run build`.

### Solution

**Files changed** (all under `packages/ai-runner/`):

- `src/agents/shims.ts` — `'fm'` joins `AgentName`; new optional `AgentShim.textOnly?: boolean` (src/agents/shims.ts:116, set on fm only); `fmShim` (src/agents/shims.ts:445; help `fm --help`, version `what -q /usr/bin/fm`, auth `fm available --model system`, prompt `fm respond --no-stream [-m <model>] [session flags] <input>` with transcript-file sessions); `AGENT_SHIMS.fm` (src/agents/shims.ts:489); `AGENT_SESSION_CAPABILITY.fm` (src/agents/shims.ts:617; resume-by-id + session-dir true, persistent stdin and structured output false, `verifiedAgainst: 'FoundationModels-2.0.68.1.402'`, note naming both gaps); `'fm'` appended last in `DISPLAY_ORDER`; absent from `TIER1_PRIORITY`/`TIER2_AGENTS`.
- `src/agents/auth-shims.ts` — `AUTH_PATTERNS.fm = { positive: /System model available/i, negative: /unavailable/i }` (src/agents/auth-shims.ts:73); doctor "authenticated" means "system model available".
- `tests/agents/shims.test.ts` — new `fm shim (task 0083)` block: version/auth/help/prompt argv, model pin, mode ignored, all four session branches, `textOnly` exclusivity, list membership, capability row; two generic invariants fm deliberately breaks relaxed with comments (version-probe binary is `what`; `verifiedAgainst` may be the FoundationModels build identifier).
- `tests/agents/auth-shims.test.ts` — fm tri-state: `System model available` ⇒ authenticated; `System model unavailable: modelNotReady` (exit 1) ⇒ unauthenticated.
- `tests/agent-detector.test.ts` — detector reports the first `what` line verbatim from the real three-line output; `what` exit 1 ⇒ not installed (Linux/older-macOS path).
- `tests/doctor-runner.test.ts` — fm doctor row: system-model probe drives auth; `DoctorResult` carries no probe text.
- `tests/fm-live.test.ts` (new; guard at tests/fm-live.test.ts:22) — live test guarded by `process.platform === 'darwin'` + `fm available --model system` exit 0; two prompts through `AiRunner`, second recalls the first; skips with a stated reason otherwise.
- `tests/ai-runner.test.ts` — same version-probe carve-out in "builds every shim command variant".
- `README.md` — `fm` in the identifier list, session/capability matrix, and agent table, marked text-only / never auto-selected.

**Key design decisions**

- Session bootstrap follows feature K R4: fresh open is sessionDir-only (`--save-transcript <dir>/fm-session.json`); resume uses `sessionId: 'fm-session'`, which resolves to that same file (`--resume <f> --save-transcript <f>`). Verified live: `fm respond --resume <missing>` exits 1 ("Unable to read transcript at …"), so a missing transcript fails the run rather than silently starting fresh — fm's own behavior, exactly as designed.
- No changes to `AgentDetector`, `DoctorRunner`, or `AiRunner`: the generic non-zero-exit ⇒ not-installed branch and first-line version reporting already handle `what -q /usr/bin/fm` (prints the `PROGRAM:fm  PROJECT:…` line three times, once per binary slice).
- `mode` is ignored (no `--schema` passthrough through the generic `PromptOptions` — structured output is ts-decision-fm's surface); the shim stays pure (no filesystem I/O; `joinPath` from `@gobing-ai/ts-runtime` only).

**Verification**

- `bun test packages/ai-runner` — 298 pass / 0 fail across 24 files, including the live session-recall test on this darwin host (fm `FoundationModels-2.0.68.1.402`) and all stubbed suites that pass without fm (AC6).
- `bun run lint` — exit 0 (Biome `--error-on-warnings` + per-package `tsc --noEmit`); 2 test files auto-formatted via `bun run format`.
- No new dependencies, no `workspace:*` changes, no changes to `docs/00`–`05` or `docs/design`.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | packages/ai-runner/src/agents/shims.ts:17 (`'fm'` in AgentName), :446-451+:473 (fmShim: command 'fm', tier 1, help `fm --help`, version `what -q /usr/bin/fm`, auth `fm available --model system`), :489 (AGENT_SHIMS.fm); tests/agents/shims.test.ts:655-678 assert all fields. |
| R2 | MET | packages/ai-runner/src/agents/shims.ts:452-472 (`fm respond --no-stream`, optional `-m <model>`, input positional; mode ignored, no `--schema` passthrough); tests/agents/shims.test.ts:679-695. |
| R3 | MET | packages/ai-runner/src/agents/shims.ts:460-469 (sessionId → `--resume <f> --save-transcript <f>` with `joinPath(sessionDir, '<id>.json')` or bare `<id>.json`; sessionDir-only → `<dir>/fm-session.json`; otherwise no transcript flags; `continue` never read; pure argv strings, no fs I/O); tests/agents/shims.test.ts:698-740 cover all four branches. |
| R4 | MET | packages/ai-runner/src/agents/shims.ts:116 (`readonly textOnly?: boolean` on AgentShim), :449 (fm sets true); grep of src confirms no other shim sets it; tests/agents/shims.test.ts:742-746 assert exclusivity. |
| R5 | MET | packages/ai-runner/src/agents/shims.ts:633-643 (TIER1_PRIORITY without fm), :662 (TIER2_AGENTS = {'openclaw'} only), :646-660 ('fm' last in DISPLAY_ORDER); tests/agents/shims.test.ts:748-753 plus isAgentName/resolveAgentName asserts at :655-657. |
| R6 | MET | packages/ai-runner/src/agents/auth-shims.ts:73-76 (positive /System model available/i, negative /unavailable/i); negative-before-positive at auth-shims.ts:184-185 prevents `System model unavailable…` false-matching; tests/agents/auth-shims.test.ts:228-240. |
| R7 | MET | packages/ai-runner/src/agents/shims.ts:617-625 (resumeById+sessionDir true, stdin+structuredOutput false, verifiedAgainst 'FoundationModels-2.0.68.1.402', note naming both gaps); tests/agents/shims.test.ts:755-765. |
| R8 | MET | version/auth/prompt argv tests/agents/shims.test.ts:665-695, all session branches :698-740, detector parse of the real three-line `what` output and exit-1 not-installed tests/agent-detector.test.ts:127-152, doctor row tests/doctor-runner.test.ts:302-335, list membership tests/agents/shims.test.ts:748; all suites stubbed via FakeExecutor so they run without fm; execution evidence: .spur/run/0083-test-gate.log (PASS — 2401 tests / 0 fail, 210 files, digest-bound, see Evidence). |
| R9 | MET | packages/ai-runner/tests/fm-live.test.ts:20 (guard: darwin AND `fm available --model system` exit 0 via runAuthCommand, ai-runner.ts:218), :23 test.skipIf, two prompts through AiRunner with sessionDir/sessionId and second-recalls-first assertion (:24-56). |
| R10 | MET | packages/ai-runner/README.md:37 (identifier list, `fm` (text-only)), :350 (session table row), :509 (agent table row marked text-only / excluded from TIER1_PRIORITY auto-selection). |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC-1 | MET | test | packages/ai-runner/src/agents/shims.ts:451 (`what -q /usr/bin/fm`; no --version flag exists); tests/agent-detector.test.ts:127-141 report the first `what` line verbatim as the version. |
| AC-2 | MET | test | packages/ai-runner/src/agents/auth-shims.ts:73-76 (system-model probe patterns); tests/doctor-runner.test.ts:302-335 (probe drives authenticated/unauthenticated tri-state; DoctorResult carries no probe text). |
| AC-3 | MET | test | packages/ai-runner/src/agents/shims.ts:452-472 (headless `fm respond --no-stream … <input>`); generic stdout passthrough unchanged (packages/ai-runner/src/ai-runner.ts:185); live response attested by tests/fm-live.test.ts:23-56 (gate log records the live suite passing on this darwin host). |
| AC-4 | MET | test | packages/ai-runner/src/agents/shims.ts:460-466 (`--resume <f> --save-transcript <f>`); tests/agents/shims.test.ts:698-710; live transcript-continuation test tests/fm-live.test.ts:23-56 (second prompt asserts BANANA42 recall). |
| AC-5 | MET | test | packages/ai-runner/src/agents/shims.ts:116,449 (textOnly on fm only) + :633-643,:662 (absent from TIER1_PRIORITY/TIER2_AGENTS); tests/agents/shims.test.ts:742-753. |
| AC-6 | MET | test | no fm dependency on Linux: detector negative path tests/agent-detector.test.ts:143-152, live test skipped unless darwin+probe tests/fm-live.test.ts:20-23; recorded full gate .spur/run/0083-test-gate.log = PASS (lint clean, spur rules pre/post clean, bun test --coverage 2401 pass / 0 fail / 210 files). |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

<!-- spur:record-review -->

**SECU findings** (pipeline verify step — verdict: PASS)

| Priority | Dimension | Location | Finding |
|----------|-----------|----------|----------|
| P4 | spur task check | — | task check passed |
| P4 | evidence-rule-pass | — | All behavior-bearing AC rows have executable evidence or are explicitly non-behavioral. |
| P4 | proof-input-digest | — | sha256:96879ea38bd6e82e43e1515cc834fcdd5050da07bf155eb6e9887000f5291d3b |

### References

- Feature K; ADR-031 and ADR-047 (`docs/00_ADR.md`); `docs/design/decision-fm-backend.md` § fm agent.
- Precedent shims: grok (task 0046), deepseek (task 0066).
- Consumer of `TIER1_PRIORITY`: spur `packages/app/src/services/agent-service.ts:2188`.
- Concurrency: no other worktrees; no `wip` tasks (checked 2026-09-23).

### History

- 2026-09-23T18:04:53.564Z todo → wip (system)
- 2026-09-23T18:22:28.777Z wip → testing (system)
- 2026-09-23T18:25:11.668Z testing → done (system)

