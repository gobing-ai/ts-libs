Pi RPC turn-session driver fixtures (task 1277, captured 2026-10-23).

PROVENANCE — exact source of every row below:
- Binary: `pi 0.87.1`, the repository dependency of the Spur worktree
  (`spur-new-dev-runall-g74-53db/node_modules/.bin/pi`), captured via live JSONL probes over
  `pi --mode rpc --no-session` (single-turn, two-turn warm capture, and a mid-run abort of a
  `sleep 60` bash tool call).
- The PATH binary (`which pi` = 1.4.0) was ALSO probed the same day and speaks the same protocol
  family; it additionally returns `data.disposition: "started"` on the prompt response and
  `aborted: true` on `agent_settled`. The driver qualifies 0.87.1 ONLY (the version the warm seam
  actually spawns) and tolerates both shapes in its decoder.

REDACTIONS (shapes preserved, contents removed):
- `message_end` (system) rows and `agent_end.messages` were replaced with skeleton rows — the
  system content contains the capture host's full prompt (secret: none, but host-private text).
- Session identifiers, extension ids and provider-usage numbers are replaced with placeholders.
- Verbose record streams (`message_update` deltas, `extension_ui_request` widgets) are trimmed to
  one representative row per family; order and families are as captured.

FILES
- `success-two-turns.jsonl` — prelude (extension noise), then two keyed turns in ONE process,
  each: prompt response echo → agent_start/turn_start → message_end(system, user, assistant) →
  turn_end → agent_end → agent_settled. Drives the AC2 warm-session test.
- `exit-before-settled.jsonl` — prompt response accepted, then the process ends before
  `agent_settled`: acceptance is not completion, outcome must settle `outcome-unknown` (AC3).
- `settled-aborted.jsonl` — 1.4.0-shape `agent_settled` with `aborted: true` (decoder unit test
  for the aborted discriminator; the cancel→interrupted path itself never needs this fixture).
- `exit-before-any-record.jsonl` — empty file: the child exits before speaking (not-started).
- `malformed.jsonl` — one valid startup row then a non-JSON line (contract-violation).

Fabricated fixtures are forbidden: every record family/shape above appeared in the probes; the
only synthesized content is placeholder text in redacted positions.
