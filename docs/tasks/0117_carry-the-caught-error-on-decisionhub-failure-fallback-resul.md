---
schema_version: 1
name: Carry the caught error on DecisionHub failure fallback results
status: todo
template: feature-impl
created_at: 2026-10-19T18:41:27.404Z
updated_at: "2026-10-19T18:43:16.122Z"
feature_id: O2

---

## 0117. Carry the caught error on DecisionHub failure fallback results

### Background

Implements: R1 — Failure fallbacks carry the caught error.

`DecisionHub.decide` catches backend failures at `packages/ai-decision/src/hub.ts:333-340` and maps them to a reason, but discards the error object; `fallbackResult` (`hub.ts:366`) has no error parameter. Downstream Spur stores `decision_logs.error` and knowledge-kit logs fallbacks, and both see only `reason: 'error'` with no cause (observed 2026-10-19: Spur laya-local fallbacks were a missing worker script, invisible until traced by hand). ADR-040 item 1; design `docs/design/ai-decision-catalog.md` § Maker chains, shadow and diagnostics. This task ships first: Spur task 1262 R3 consumes `result.error`.

### Requirements

- [ ] R1. Add and export `DecisionErrorInfo { readonly name: string; readonly message: string }` in `packages/ai-decision/src/hub.ts` next to `DecisionResultBase` (`:44`). Add `readonly error?: DecisionErrorInfo` to `DecisionResultBase` with TSDoc: "present only for `no-backend`, `timeout` and `error`".
- [ ] R2. Add `export const DECISION_ERROR_MESSAGE_MAX = 500` and a module-private `toErrorInfo(error: unknown): DecisionErrorInfo`:
  - `Error` instance → `{ name: error.name, message: error.message.slice(0, DECISION_ERROR_MESSAGE_MAX) }`. Use `error.name` (subclasses of `DecisionError` set it; verify `DecisionTimeoutError.name === 'DecisionTimeoutError'` in `packages/ai-runner/src/decision/errors.ts`; if a class does not set `name`, fall back to `error.constructor.name`).
  - Non-`Error` throw → `{ name: 'NonError', message: String(error).slice(0, 500) }`.
  - Never include `stack`, `cause`, request text or state.
- [ ] R3. `fallbackResult` (`hub.ts:366`) gains an optional trailing `error?: DecisionErrorInfo` parameter and spreads `...(error !== undefined ? { error } : {})` into `base`. The catch block (`hub.ts:333-340`) passes `toErrorInfo(error)`.
- [ ] R4. The `answer === undefined || answer.kind !== definition.type` branch (`hub.ts:~300`) returns `reason: 'error'` today with no thrown error. Give it a synthesized `{ name: 'DecisionBackendError', message: 'Maker returned no answer of type <type> for "<id>"' }` so every `error` reason carries `error`.
- [ ] R5. `low-confidence` and `accepted` results never carry `error`. No other field of any result changes.
- [ ] R6. Tests in `packages/ai-decision/tests/hub.test.ts`, written first (see Plan), recorded through `decideAndRecord` so they land in the E2E transcript.
- [ ] R7. Regenerate `packages/ai-decision/tests/output/hub-e2e-transcript.json`: existing failure-reason entries gain `error`. The `afterAll` (`hub.test.ts:38-43`) asserts every recorded result is contained in the file, so update the file to the new results and review the diff; only `error` keys may be added to existing entries, plus the new cases.
- [ ] R8. Docs:
  - `packages/ai-decision/README.md` § The fallback contract: one sentence that failure reasons carry `error: { name, message }` (≤ 500 chars).
  - `docs/design/ai-decision-catalog.md` § API `ResultBase`: add `error?`.

### Acceptance Criteria

- [ ] AC1 — Failure fallbacks carry the caught error

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

**Chosen.** A plain `{ name, message }` record on the result, built in the one catch that already exists. Consumers persist it verbatim (Spur `decision_logs.error`).

**Rejected.**
- Attaching the `Error` object: not JSON-serializable, leaks stacks into logs, breaks the transcript's `toContainEqual`.
- An `onError` hook on the hub: extra lifecycle for a value that fits on the result.
- Including `stack` or the failing request: secrets and prompt text in logs.

**Frozen names.** `DecisionErrorInfo`, `DecisionResultBase.error`, `DECISION_ERROR_MESSAGE_MAX`. `DecisionError` is taken (ts-ai-runner base class) — do not reuse it.

**Invariants.**
- `decide` still never rejects for steps 4–7; a throwing `toErrorInfo` is impossible (no I/O, guards non-Error).
- `error` present ⇔ reason ∈ {`no-backend`, `timeout`, `error`}.
- Message length ≤ 500.

**Failure modes, written before the code:**
1. Factory throws `DecisionConfigError('LAYA_WORKER_SCRIPT missing')` → `no-backend`, `error.name === 'DecisionConfigError'`.
2. `ask` rejects `DecisionTimeoutError` → `timeout`, name and message preserved.
3. `ask` rejects a plain `Error('boom')` → `error`, `{ name: 'Error', message: 'boom' }`.
4. `ask` rejects a string `'boom'` → `error`, `{ name: 'NonError', message: 'boom' }`.
5. Invalid answer (validateAnswers throws `DecisionBackendError`) → `error` with that name.
6. Answer missing for the id → `error`, synthesized `DecisionBackendError` info (R4).
7. 2,000-char message → 500 chars.
8. Low-confidence and accepted → no `error` key (`'error' in result === false`).

**Anti-patterns.** Do not touch the reason mapping; do not add `error` to `DecisionAttempt` here (the chain task does); do not change `durationMs` timing.

### Plan

1. **Tests first** in `packages/ai-decision/tests/hub.test.ts`: one `describe('fallback diagnostics (ADR-040)')` with failure modes 1–8, using the file's existing scripted-maker helpers and `decideAndRecord`. Run `bun test packages/ai-decision/tests/hub.test.ts` — the new cases fail.
2. Implement R1–R5 in `packages/ai-decision/src/hub.ts`.
3. Rerun the file; the new cases pass, the `afterAll` transcript check fails. Regenerate the transcript (R7) and review `git diff packages/ai-decision/tests/output/hub-e2e-transcript.json`: only added `error` keys and new cases.
4. Docs (R8).
5. Gate: `bun run spur-check && bun run build`; `git status` shows only the files below.

**Files touched:** `packages/ai-decision/src/hub.ts`, `packages/ai-decision/tests/hub.test.ts`, `packages/ai-decision/tests/output/hub-e2e-transcript.json`, `packages/ai-decision/README.md`, `docs/design/ai-decision-catalog.md`.

**Depends on:** none in-repo. It edits only `hub.ts` lines O1 does not touch, so it may run before or after 0114–0116. Downstream: Spur task 1262 R3 waits for its release.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- Feature O2; ADR-040 (`docs/00_ADR.md`), ADR-033.
- `docs/design/ai-decision-catalog.md` § Maker chains, shadow and diagnostics.
- Downstream consumer: spur-new task 1262 R3 (`decision_logs.error` mapping).

**Premises (verified 2026-10-19):**

- `packages/ai-decision/src/hub.ts:333-340` — catch maps to reason and calls `fallbackResult(definition, makerName, reason, null, start)`; the error is discarded.
- `packages/ai-decision/src/hub.ts:366` — `fallbackResult` signature has no error parameter.
- `packages/ai-decision/src/hub.ts:44-53` — `DecisionResultBase` has no `error` field.
- `packages/ai-decision/tests/hub.test.ts:38-43` — the transcript `afterAll` uses `toContainEqual`, so changed results require regenerating `tests/output/hub-e2e-transcript.json`.
- `packages/ai-decision/src/index.ts:3` — `export * from './hub'`, so new exports need no barrel edit.

### History

- 2026-10-19T18:43:16.122Z backlog → todo (system)

