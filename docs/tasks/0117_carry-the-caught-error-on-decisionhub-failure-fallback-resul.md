---
schema_version: 1
name: Carry the caught error on DecisionHub failure fallback results
status: done
template: feature-impl
created_at: 2026-10-19T18:41:27.404Z
updated_at: "2026-10-19T21:06:38.765Z"
feature_id: O2

done_forced: "false"
done_reason: unforced close; PASS artifact at .spur/memory/evidence/0117-verdict.json
---

## 0117. Carry the caught error on DecisionHub failure fallback results

### Background

Implements: R1 — Failure fallbacks carry the caught error.

`DecisionHub.decide` catches backend failures at `packages/ai-decision/src/hub.ts:333-340` and maps them to a reason, but discards the error object; `fallbackResult` (`hub.ts:366`) has no error parameter. Downstream Spur stores `decision_logs.error` and knowledge-kit logs fallbacks, and both see only `reason: 'error'` with no cause (observed 2026-10-19: Spur laya-local fallbacks were a missing worker script, invisible until traced by hand). ADR-040 item 1; design `docs/design/ai-decision-catalog.md` § Maker chains, shadow and diagnostics. This task ships first: Spur task 1262 R3 consumes `result.error`.

### Requirements

- [x] R1. Add and export `DecisionErrorInfo { readonly name: string; readonly message: string }` in `packages/ai-decision/src/hub.ts` next to `DecisionResultBase` (`:44`). Add `readonly error?: DecisionErrorInfo` to `DecisionResultBase` with TSDoc: "present only for `no-backend`, `timeout` and `error`".
- [x] R2. Add `export const DECISION_ERROR_MESSAGE_MAX = 500` and a module-private `toErrorInfo(error: unknown): DecisionErrorInfo`:
  - `Error` instance → `{ name: error.name, message: error.message.slice(0, DECISION_ERROR_MESSAGE_MAX) }`. Use `error.name` (subclasses of `DecisionError` set it; verify `DecisionTimeoutError.name === 'DecisionTimeoutError'` in `packages/ai-runner/src/decision/errors.ts`; if a class does not set `name`, fall back to `error.constructor.name`).
  - Non-`Error` throw → `{ name: 'NonError', message: String(error).slice(0, 500) }`.
  - Never include `stack`, `cause`, request text or state.
- [x] R3. `fallbackResult` (`hub.ts:366`) gains an optional trailing `error?: DecisionErrorInfo` parameter and spreads `...(error !== undefined ? { error } : {})` into `base`. The catch block (`hub.ts:333-340`) passes `toErrorInfo(error)`.
- [x] R4. The `answer === undefined || answer.kind !== definition.type` branch (`hub.ts:~300`) returns `reason: 'error'` today with no thrown error. Give it a synthesized `{ name: 'DecisionBackendError', message: 'Maker returned no answer of type <type> for "<id>"' }` so every `error` reason carries `error`.
- [x] R5. `low-confidence` and `accepted` results never carry `error`. No other field of any result changes.
- [x] R6. Tests in `packages/ai-decision/tests/hub.test.ts`, written first (see Plan), recorded through `decideAndRecord` so they land in the E2E transcript.
- [x] R7. Regenerate `packages/ai-decision/tests/output/hub-e2e-transcript.json`: existing failure-reason entries gain `error`. The `afterAll` (`hub.test.ts:38-43`) asserts every recorded result is contained in the file, so update the file to the new results and review the diff; only `error` keys may be added to existing entries, plus the new cases.
- [x] R8. Docs:
  - `packages/ai-decision/README.md` § The fallback contract: one sentence that failure reasons carry `error: { name, message }` (≤ 500 chars).
  - `docs/design/ai-decision-catalog.md` § API `ResultBase`: add `error?`.

### Acceptance Criteria

- [x] AC1 — Failure fallbacks carry the caught error

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

| File | Lines | Change |
| --- | --- | --- |
| `packages/ai-decision/src/hub.ts` | 44-79 | `DECISION_ERROR_MESSAGE_MAX = 500`, the exported `DecisionErrorInfo { name, message }`, and the module-private `toErrorInfo` (an `Error` keeps its `name` — subclasses of `DecisionError` set their own, and one that does not is named by its constructor rather than `'Error'` — with the message truncated; a non-`Error` throw becomes `NonError`; no stack, cause or request text). `DecisionResultBase` gains `readonly error?: DecisionErrorInfo`, documented as present only for `no-backend`, `timeout` and `error`. |
| `packages/ai-decision/src/hub.ts` | 325-336 | The `answer === undefined \|\| kind !== type` branch synthesizes a `DecisionBackendError` info so every `error` reason carries a cause even when nothing was thrown (R4). Reachable only if the answer validator ever becomes lenient: `validateAnswers` rejects a name or kind mismatch first, which the new test records. |
| `packages/ai-decision/src/hub.ts` | 356-372 | `fallbackResult` takes an optional trailing `error` and spreads it into the base only when present, so accepted and `low-confidence` results never gain the key; the catch passes `toErrorInfo(error)`. The reason mapping, timing and every other field are untouched. |
| `packages/ai-decision/tests/hub.test.ts` | 1233-1330 | New `describe('fallback diagnostics (ADR-040)')` covering the task's failure modes 1-8: factory throw → `no-backend`, timeout, plain `Error`, non-`Error` throw, invalid answer, wrong-kind answer, 2,000-char truncation, and accepted/low-confidence carrying no `error` key. Six pre-existing exact assertions gained the `error` block they now receive. |
| `packages/ai-decision/tests/output/hub-e2e-transcript.json` | — | Regenerated. Diff is purely additive: 28 existing failure-reason entries gained `error`, 9 new diagnostics cases appended, nothing removed or reordered. |
| `packages/ai-decision/tests/output/agent-e2e-transcript.json` | — | Regenerated for the same reason (the `llm-agent` suite drives the hub): 5 entries gained `error`, no other change. |
| `packages/ai-decision/README.md` | 139-142 | § The fallback contract: failure reasons carry `error: { name, message }` capped at 500 characters, accepted and `low-confidence` never do, consumers persist it verbatim. |
| `docs/design/ai-decision-catalog.md` | 267 | § API `ResultBase` documents `error?: DecisionErrorInfo`. |

The failure object is a plain record, not the `Error`: an `Error` does not survive `toContainEqual` or JSON, and a stack plus a `cause` chain would put prompt text and internals into the consumer's logs (Spur writes `decision_logs.error` verbatim). The message is capped, the name is solver-readable, and the key is present exactly when `reason ∈ {no-backend, timeout, error}`. `decide` still never rejects for a backend outcome: `toErrorInfo` does no I/O and guards non-`Error` throws.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `DecisionErrorInfo` at `packages/ai-decision/src/hub.ts:51-54` and `readonly error?: DecisionErrorInfo` on `DecisionResultBase` at `:80`, documented as present only for the three failure reasons; both reach the barrel through the existing `export * from './hub'`. |
| R2 | MET | `DECISION_ERROR_MESSAGE_MAX = 500` at `packages/ai-decision/src/hub.ts:44`; `toErrorInfo` at `:60-66` truncates to the constant, maps a non-`Error` throw to `NonError`, prefers a class-set `name` over the constructor name, and touches no stack, cause or request text. |
| R3 | MET | `fallbackResult` takes the optional trailing `error` and spreads it only when defined at `packages/ai-decision/src/hub.ts:356-372`; the catch passes `toErrorInfo(error)` at `:372`. |
| R4 | MET | The missing/wrong-kind branch synthesizes `{ name: 'DecisionBackendError', message: 'Maker returned no answer of type <type> for "<id>"' }` at `packages/ai-decision/src/hub.ts:325-336`. |
| R5 | MET | The spread is conditional, so accepted and `low-confidence` results carry no key — asserted by failure mode 8 at `packages/ai-decision/tests/hub.test.ts:1309-1329`; no other field or the reason mapping changed. |
| R6 | MET | `describe('fallback diagnostics (ADR-040)')` at `packages/ai-decision/tests/hub.test.ts:1233-1330` covers modes 1-8 through `decideAndRecord`, so each result also lands in the transcript. |
| R7 | MET | `packages/ai-decision/tests/output/hub-e2e-transcript.json` regenerated: `git diff --stat` reports 239 insertions and 0 deletions, and a slot-by-slot comparison shows 28 existing entries gained only `error` plus 9 new diagnostics cases. |
| R8 | MET | README § The fallback contract at `packages/ai-decision/README.md:139-142`; `docs/design/ai-decision-catalog.md:267` documents `error?: DecisionErrorInfo` on `ResultBase`. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC1 — Failure fallbacks carry the caught error | MET | command | `bun test packages/ai-decision/tests/hub.test.ts` — 44 pass / 0 fail, including failure modes 1-8 at `packages/ai-decision/tests/hub.test.ts:1233-1330`; the committed transcript pins the recorded results at `packages/ai-decision/tests/output/hub-e2e-transcript.json`. |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

**Scope.** The 0117 diff on `sp/runall-o2-a2cf`: the failure-diagnostics record on `DecisionResult`,
its test block, both recorded e2e transcripts, the package README and the catalog design doc.
`bun run spur-check` (3086 pass / 0 fail, 62 pre + 5 post rules, fixtures 52/52) and `bun run build`
(12/12 packages) were re-run on the final tree.

**Functional traceability.** R1-R8 MET, each row carrying a `path:line` anchor in the run's review
answer (`.spur/run/9bd50675-3db6-4027-92fb-65e4ac8e96fb-review-answer.txt`); AC1 MET with executable
(`command`) evidence. `spur task verdict --from-answer` derives PASS and writes
`.spur/run/0117-verdict.json`.

**SECUA.** Security: the record is deliberately narrow — name plus a 500-character message, no stack,
`cause` chain or request text — so persisting it cannot leak prompts or internals. Errors: `decide`
still never rejects for a backend outcome and `toErrorInfo` is total. Correctness: `error` is present
exactly for the three failure reasons, and the conditional spread leaves accepted/low-confidence
results byte-identical. Usability: the README states the contract and the cap. Architecture: one plain
record built in the existing catch, keeping `DecisionResult` JSON-serializable.

**Architectural depth.** The diagnostics ride the result envelope the hub already builds, so a
consumer needs no new call path to learn why a decision fell back; `DecisionErrorInfo` is the shared
shape the chain and shadow work reuses.

**Findings.**

| Priority | Finding | Location | Disposition |
| --- | --- | --- | --- |
| P4 | R4's synthesized branch is defensive — `validateAnswers` rejects a missing or wrong-kind answer first, so the branch is unreachable through the public path today. | `packages/ai-decision/src/hub.ts:325` | RESOLVED (three lines that keep the invariant true if the validator ever loosens) |
| P4 | The `llm-agent` e2e transcript also needed regeneration because its hub-driven failure cases gain `error`. | `packages/ai-decision/tests/output/agent-e2e-transcript.json` | RESOLVED (five entries changed, nothing else) |

Verdict: PASS
Confidence: HIGH

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
- 2026-10-19T21:05:16.347Z todo → wip (system)
- 2026-10-19T21:06:37.726Z wip → testing (system)
- 2026-10-19T21:06:38.760Z testing → done (system)

