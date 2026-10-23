# Claude stream-json turn-session fixtures (task 1276)

Captured from the installed Claude Code binary on this host, 2026-10-22:

- **Binary:** `/opt/homebrew/bin/claude` — `claude --version` → `2.1.308 (Claude Code)`
- **Invocation:** `claude -p --input-format stream-json --output-format stream-json --verbose`
- **Redaction:** session ids → `<uuid>` placeholders, `cwd` → `/tmp/spur-claude-fixture`,
  timestamps (`resetsAt`) → `0`. Record types, subtypes, ordering and `is_error` values are
  unmodified; large incidental arrays (tool lists) trimmed to protocol-relevant fields.

| Fixture | Probe | Exit | Asserts |
| --- | --- | --- | --- |
| `success-two-turns.jsonl` | two user frames, one process | 0 | warm reuse: one session id, one `result` per turn, per-turn `init` |
| `error-result.jsonl` | `--model nonexistent-model-xyz` | 1 | API error keeps `subtype: "success"` with `is_error: true` |
| `interrupted-turn.jsonl` | user frame + interrupt `control_request` | 1 | `control_response` ack, then `result error_during_execution` |
| `partial-output-no-result.jsonl` | child killed before the `result` record | — | `init` + `assistant` + noise, no terminal row (→ `outcome-unknown`) |
| `exit-before-any-record.jsonl` | child SIGKILLed ~50ms after spawn | 137 | zero records (→ `not-started`) |

`partial-output-no-result.jsonl` is the captured partial transcript truncated before its `result`
row; the replay child reproduces the truncation deterministically (the original probe's count
completed before the kill). Protocol conclusions recorded in
`src/turn-drivers/claude-stream-json.ts`.
