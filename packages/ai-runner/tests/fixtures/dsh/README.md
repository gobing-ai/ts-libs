dsh headless `--json` fixtures (task 0122, captured 2026-11-26).

PROVENANCE — exact source of every file below:
- Binary: `dsh 0.2.2-rc.1` on PATH (`dsh --version`), the installed release the
  `deepseek` capability row is verified against.
- Capture cwd: a scratch directory outside this repository (`/tmp/dsh-scratch`), so no
  repository file could be read or written by a probe.
- `completed.jsonl` — exit **0**:
  `dsh --profile headless --json --permission-mode workspace-write --approval-policy never -- "Reply with exactly one word: ready"`
- `not-completed.jsonl` — exit **1**:
  `dsh --profile headless --json --session-id session-bogus -- "x"`

EXIT-MAPPING CONTRACT (task 0122 R3). dsh exits 0 only when the run ends with a final
`turn/end` whose `reason.kind` is `"completed"`; every other outcome exits 1
(`vendors/deepseek-harness/packages/bundle/headless/src/index.ts:441`). A caller may
therefore treat the exit status as the run outcome without parsing events. The fixture
test asserts exactly that pairing: `exit 0 ⇔` a `final` event with
`reason.kind === "completed"` (and exit 1 ⇒ no such `final`).

WHY `not-completed.jsonl` IS THE SESSION-ERROR STREAM. The preferred capture was a SIGINT
after the first `status` event. Probed 2026-11-26: an interrupted run exits **130**
(128 + SIGINT), not 1, and its stream ends in an internal `error` event ("flush on a closed
handle") — it does not demonstrate the exit-1 arm of the contract. The sanctioned fallback
(the unknown-`--session-id` rejection, an `error` event with no `final`) does, so it is what
this fixture records.

REDACTIONS (shapes preserved, contents removed):
- `session.sessionId` / `final.sessionId` → `<SESSION_ID>` (a live local session identifier).
- `session.cwd` → `<CWD>` (the absolute capture path; dsh always emits the absolute cwd here).
- The error message's session id → `<SESSION_ID>`; the message text is unchanged.
- Everything else is verbatim, including event `type`s, order, `status` phases and the
  `usage` counters.

Fabricated fixtures are forbidden: every row above appeared in the probes; the only
synthesized content is placeholder text in redacted positions.
