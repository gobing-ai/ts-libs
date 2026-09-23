---
schema_version: 1
name: Add the fm text-only agent shim to ts-ai-runner
status: todo
template: feature-impl
created_at: 2026-09-23T16:30:08.841Z
updated_at: "2026-09-23T16:36:15.820Z"
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

- [ ] R1. `AgentName` gains `'fm'`; `AGENT_SHIMS.fm` has `command: 'fm'`, `tier: 1`, help `fm --help`, version `what -q /usr/bin/fm`, auth `fm available --model system`.
- [ ] R2. `getPromptCommand` returns `fm respond --no-stream [-m <model>] [session flags] <input>`; `mode` is ignored (no schema to pass through generic `PromptOptions`).
- [ ] R3. Session argv: `sessionId` set → `--resume <f> --save-transcript <f>` where `<f>` = `joinPath(sessionDir, `${sessionId}.json`)`, or `${sessionId}.json` when `sessionDir` is unset; only `sessionDir` → `--save-transcript <sessionDir>/fm-session.json`; neither → no transcript flags; `continue` alone degrades to a fresh call. The shim does no filesystem I/O.
- [ ] R4. `AgentShim` gains optional `readonly textOnly?: boolean`; `fm` sets `true`; no other shim sets it.
- [ ] R5. `fm` is absent from `TIER1_PRIORITY` and `TIER2_AGENTS`, appended last in `DISPLAY_ORDER`; `resolveAgentName('fm') === 'fm'` and `isAgentName('fm')` is true.
- [ ] R6. `AUTH_PATTERNS.fm = { positive: /System model available/i, negative: /unavailable/i }`.
- [ ] R7. `AGENT_SESSION_CAPABILITY.fm = { supportsResumeById: true, supportsSessionDir: true, supportsPersistentStdin: false, supportsStructuredOutput: false, verifiedAgainst: 'FoundationModels-2.0.68.1.402', note }` with a note naming both gaps.
- [ ] R8. Unit tests cover version/auth/prompt argv, every session branch, detector parse of the real `what` output, doctor row, and list membership; they pass on Linux without `fm`.
- [ ] R9. One live test runs only when `process.platform === 'darwin'` and `fm available --model system` exits 0; it runs two prompts through `AiRunner` with a session and checks the second recalls the first.
- [ ] R10. `packages/ai-runner/README.md` lists `fm` in the identifier list, the session table and the agent table, marked text-only.

Out of scope: a structured-output mode for the agent (belongs to ts-decision-fm), `fm chat`/`fm serve`, PCC models, any change to `AgentDetector` or `DoctorResult`.

### Acceptance Criteria

- [ ] AC1 — ts-ai-runner detects the fm agent and reports its version without a version flag
- [ ] AC2 — Doctor reports fm model availability from the system-model probe
- [ ] AC3 — A prompt sent through the fm agent returns the model text response
- [ ] AC4 — A second fm prompt in the same session continues the saved transcript
- [ ] AC5 — The fm agent declares itself text-only and is never auto-selected for tool-using work
- [ ] AC6 — The test suites pass on Linux CI and exercise the live model only on capable hosts

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

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- Feature K; ADR-031 and ADR-047 (`docs/00_ADR.md`); `docs/design/decision-fm-backend.md` § fm agent.
- Precedent shims: grok (task 0046), deepseek (task 0066).
- Consumer of `TIER1_PRIORITY`: spur `packages/app/src/services/agent-service.ts:2188`.
- Concurrency: no other worktrees; no `wip` tasks (checked 2026-09-23).

### History
