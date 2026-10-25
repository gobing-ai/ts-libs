Codex App Server turn-session driver fixtures (task 1278, captured 2026-10-24).

PROVENANCE — exact source of every row below:
- Binary: `codex-cli 0.164.0` (`codex --version`), the host install the protocol was qualified
  against, driven as `codex app-server` over its JSONL stdio control channel. Captures come from
  four live probes: one turn (`probe-raw`), two serial turns on ONE thread plus a third turn after
  `thread/resume` from a second process, a mid-turn `turn/interrupt`, and a turn against an
  unsupported model (the `failed` status path).
- Protocol shapes cross-checked against the bindings the binary itself generates
  (`codex app-server generate-ts`): `initialize` → `thread/start` | `thread/resume` →
  `turn/start` → `turn/completed`, with `TurnStatus = completed | interrupted | failed | inProgress`.
- The npm-installed runner pin lives in `src/turn-drivers/codex-app-server.ts`
  (`CODEX_TURN_VERIFIED_VERSION`), and the capability row
  (`src/agents/shims.ts`, `verifiedAgainst`) names the same version.

REDACTIONS (shapes preserved, contents removed):
- Host paths replaced: `/Users/<user>/xprojects/<checkout>` → `/work/spur`, `/Users/<user>` →
  `/home/user` (the `cwd`, `instructionSources`, rollout path and `codexHome` values).
- Startup noise (`mcpServer/startupStatus/updated`, `hook/started|completed`, `account/*`,
  `thread/tokenUsage/updated`, `remoteControl/status/changed`, `configWarning`) is trimmed to the
  representatives kept in each file; the driver ignores the family entirely.
- Native thread/turn ids, model names and token counts are AS CAPTURED: they are the evidence the
  driver test asserts on (one shared thread id, distinct turn ids per turn).

FILES

- `success-two-turns.jsonl` — initialize, thread/start, then two serial `turn/start` turns on one
  thread: acceptance (`status: inProgress`), `item/agentMessage` records, `turn/completed`
  `completed` with `final_answer` text ALPHA then BETA. AC1/AC2 evidence.
- `resume-third-turn.jsonl` — a SECOND app-server process answering `thread/resume` for the same
  thread id and completing a third turn (GAMMA): the resume form of the handshake. AC1 evidence.
- `interrupted-turn.jsonl` — `turn/start`, then the `turn/interrupt` response and a
  `turn/completed` with status `interrupted` and `error: null` (the cancel path; the facade maps a
  requested cancel to `interrupted`). AC3 evidence.
- `failed-turn.jsonl` — `turn/completed` with status `failed` and `error.message` carrying the
  provider's 400 (`gpt-nonexistent-model-xyz`), i.e. a native failure that must never become a
  successful task result. AC3 evidence.

Replay: `tests/turn-drivers/codex-replay-agent.ts` serves these rows over a real child process; the
segment after an interrupt response is held until the parent sends `turn/interrupt`, so the cancel
test exercises the real ordering.
