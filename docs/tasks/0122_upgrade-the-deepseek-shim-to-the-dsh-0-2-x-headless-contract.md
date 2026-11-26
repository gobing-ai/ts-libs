---
schema_version: 1
name: Upgrade the deepseek shim to the dsh 0.2.x headless contract
status: todo
template: feature-impl
created_at: 2026-11-26T22:15:41.365Z
updated_at: "2026-11-26T22:23:43.318Z"
feature_id: I1

priority: P2
estimate_hours: 3
---

## 0122. Upgrade the deepseek shim to the dsh 0.2.x headless contract

### Background

Task 0066 added `dshShim` (canonical id `deepseek`) against dsh 0.1.5-rc.1, when the headless app took only the task positional. dsh 0.2.x headless adds `--json` NDJSON events, `--session-id` resume, `--permission-mode`, `--approval-policy` and `--add-dir` (`dsh --profile headless --help`, installed 0.2.2-rc.1). The shim still emits only `['--profile','headless', input]` (`packages/ai-runner/src/agents/shims.ts:435`), and its capability row (`:634`) declares no resume and no structured output.

Feature: ts-libs `I1` (child of `I`, whose 0.1.5 scenarios R2/R3 this task supersedes). Consumer: Spur feature B81 ("DeepSeek Harness (dsh) as a wrapped coding agent"), ADR-153 and `docs/design/dsh-agent-integration.md` in the spur repo (`~/xprojects/spur-new`). Spur task 1456 bumps its catalog to the release this task produces; Spur tasks 1457/1458 depend on that.

Facts the design rests on (harness source `~/xprojects/spur-new/vendors/deepseek-harness/packages/bundle/headless/` — `README.md` and `src/` — plus live probes on dsh 0.2.2-rc.1 that make no model call):
- Exit mapping: a completed final `turn/end` exits 0; any other outcome exits 1 (§ Exit mapping, README:136; source `src/index.ts:441` `io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)`).
- `--json` opens with `{type:'session',sessionId,cwd}` and ends with `{type:'final',sessionId,reason,text}` (`src/json-stream.ts:320`, `:327`); `reason` is `null` without a terminal turn. The `session` event carries the absolute cwd, so fixtures must redact it.
- Flags are declared in `src/startup.ts:58-63`; blank-task and empty-value usage errors at `:123-146`. § Supervising (README:96) still tells supervisors to check both exit 0 and `final.reason.kind === 'completed'`.
- A blank or whitespace-only positional is a usage error, exit 1, before any model work (README:114; probe `dsh --profile headless -- ""` → `error: a task is required`, exit 1).
- A positional after `--` is accepted, including one that starts with `-` (probe with a bogus `--session-id` reached session resolution, exit 1, no usage error).
- `workspace-write` is a built-in preset (probe: `unknown preset … (known: read-only, workspace-write, danger-full-access)`); the preset is validated before stdin or the model is touched (README:128).
- `--session-id` refuses an unknown id or a Session recorded under a different cwd (§ Choosing the session identity, README:77; probe: `session "session-bogus" does not exist`, exit 1; in `--json` mode an `error` event precedes exit).
- Directory grants and permission options must be repeated on resume (§ Supervising implementation tasks, README:90).
- There is no headless `--model` flag at 0.2.2-rc.1, so `model` keeps degrading silently.

**Refine corrections (2026-11-26)**
- Plan cited `ShimCommand` at `shims.ts:23` and `PromptOptions` at `:31` → they are at `:24` and `:32` → Plan updated.
- "spur repo" was unnamed → it is `~/xprojects/spur-new` (README and design doc exist there) → named in Background.
- R1 "the input … is never blank" → a pure argv builder cannot guarantee that; other shims pass `options.input ?? ''`, and dsh itself rejects blank input with exit 1 before model work (probed) → R1 rewritten: pass through, rely on dsh's usage error; no shim-side validation.
- Plan step 3 "checked against a real run that accepts `--`" → already verified by a no-model probe (bogus session id) → recorded as a fact; Plan keeps a cheap regression probe instead of a model run.
- Design did not freeze argv order, fixture names or the fixture provenance convention → frozen in Design (order, `tests/fixtures/dsh/` file names, README provenance block mirroring `tests/fixtures/turn-drivers/pi/README.md`).
- Feature I scenarios R2/R3 ("prompt command maps PromptOptions to dsh headless argv", "session options degrade without error") still describe 0.1.5 behavior, and this task's AC titles do not match feature scenario titles → task ACs kept task-local (`spur task check --as todo` is clean); feature scenario text update recorded as a deferred operator decision in Q&A.
- Existing tests that this task must rewrite were unnamed → named in Plan (`tests/agents/shims.test.ts:548`, `:555`, `:568`).

**Refine corrections (2026-11-26, follow-up)**
- `feature_id: I` → feature I's scope is the 0.1.5 shim (its Scope lists "advanced flags" as out, its R2/R3 scenarios assert the positional-only argv and the degrade behavior), and its tasks 0066/0067 are done → created child feature `I1` "Upgrade the dsh shim to the 0.2.x headless contract" with scenarios AC1–AC6 and linked 0122 to `I1`. Feature I is left unchanged; I1's Goal records the supersession.
- Facts cited only the README → now also cite the harness source (`src/index.ts:441`, `src/json-stream.ts:320/327`, `src/startup.ts:58-146`) and its tests (`tests/headless.spec.ts:683`, `:735`, `:807`); References lists the source tree.
- Q&A deferred item "update feature I scenarios R2/R3" → resolved by I1 rather than editing I → Q&A updated.

### Requirements

- [ ] R1. `dshShim.getPromptCommand` builds `dsh --profile headless [--json] [--session-id <id>] --permission-mode workspace-write --approval-policy never -- <input>`, with `<input>` = `options.input ?? ''` as the last argv element; blank input is not validated in the shim (dsh rejects it with exit 1 before model work)
- [ ] R2. emit `--json` only for `mode: 'json'`; `mode: 'text'` or unset emits no output flag; the shim stays a pure argv builder and parses no events
- [ ] R3. a recorded fixture set proves dsh exits 0 only when `final.reason.kind === "completed"` and exits 1 otherwise, so callers can treat the exit status as the run outcome
- [ ] R4. `sessionId` emits `--session-id <id>` together with the same permission flags; `continue: true` alone and `sessionDir` alone emit no session flag (fresh dispatch); `model`, `workspace` and `timeoutMs` stay ignored
- [ ] R5. the `deepseek` row in `AGENT_SESSION_CAPABILITY` sets `supportsResumeById: true` and `supportsStructuredOutput: true` (`supportsSessionDir`/`supportsPersistentStdin` stay false), with `verifiedAgainst` set to the installed dsh version and a note on why each false remains
- [ ] R6. availability stays `dsh --version`; `getHelpCommand` stays `dsh --help`; `getAuthCommand` stays null and no credential is read

Out of scope: an NDJSON event parser/mapper; a `PromptOptions` permission or directory-grant field and `--add-dir`; `--model`; any change to `AGENT_SHIMS`, `TIER1_PRIORITY`, `DISPLAY_ORDER`, the `ts-llm-jsonl-importer` deepseek source, or feature I's scenario text; the version bump/publish (operator-run).

### Acceptance Criteria

All ACs are observed by `packages/ai-runner/tests/agents/shims.test.ts` (AC3 reads `tests/fixtures/dsh/`). Titles match feature I1 scenarios.

- [ ] AC1 — The dsh shim builds the 0.2.x headless one-shot command (req: R1)
- [ ] AC2 — The dsh shim emits --json only in json mode (req: R2)
- [ ] AC3 — A recorded fixture ties exit 0 to a completed final reason (req: R3)
- [ ] AC4 — A dsh prompt resumes by session id with repeated permission flags (req: R4)
- [ ] AC5 — The deepseek capability row reflects the verified dsh version (req: R5)
- [ ] AC6 — dsh availability is detected without reading credentials (req: R6)

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-11-26T22:19:34.391Z

- **Closed — blank input:** pass `options.input ?? ''` through; dsh rejects blank input pre-model with exit 1 (probed 2026-11-26). No shim validation.
- **Closed — `continue` without `sessionId`:** fresh dispatch, no flag (dsh has no last-session flag).
- **Closed — AC altitude:** task-local ACs; `spur task check 0122 --as todo` is clean.
- **Deferred (owner: Robin) — feature I scenarios R2/R3** still describe 0.1.5 degrade behavior. Update the feature text after this task lands; not done here because refine never edits the feature.
- **Deferred — `--add-dir`:** see Design § Deferred.

#### Q&A entry — 2026-11-26T22:23:42.732Z

- **Closed — blank input:** pass `options.input ?? ''` through; dsh rejects blank input pre-model with exit 1 (probed 2026-11-26). No shim validation.
- **Closed — `continue` without `sessionId`:** fresh dispatch, no flag (dsh has no last-session flag).
- **Closed — feature home:** child feature `I1` under `I`, linked at Robin's request (2026-11-26). Task AC titles equal I1 scenario titles. Feature I's 0.1.5 scenarios are left as the historical record of task 0066; I1 supersedes R2/R3.
- **Deferred — `--add-dir`:** see Design § Deferred.

### Design

Approach: edit `dshShim` (`packages/ai-runner/src/agents/shims.ts:424`) and the `deepseek` capability row (`:634`) only. `AGENT_SHIMS`, `TIER1_PRIORITY` and `DISPLAY_ORDER` already list `deepseek` and stay unchanged. `ShimCommand` is `{command, args}` with no stdin channel, so the task goes after `--`, as in `fmShim` (`:459`, `--` push at `:486`). Permission flags are fixed because `PromptOptions` has no permission or grant field; `grokShim` (`:388`) likewise hard-codes its noninteractive `--allow` grant. No new exported API, type, or option.

Frozen argv (exact order; tests assert with `toEqual`):
```ts
const args = ['--profile', 'headless'];
if ((options.mode ?? 'text') === 'json') args.push('--json');
if (options.sessionId !== undefined) args.push('--session-id', options.sessionId);
args.push('--permission-mode', 'workspace-write', '--approval-policy', 'never', '--', options.input ?? '');
return { command: 'dsh', args };
```
Precedence: `sessionId` is the only session input that emits a flag. `continue` is never mapped — dsh has no "last session" flag, and guessing an id would break ADR-047 R5 (pinned-session precedence). `sessionDir` is ignored (no dsh flag; `DSH_HOME` is env, which `ShimCommand` cannot carry).

Capability row (frozen values):
- `supportsResumeById: true`, `supportsStructuredOutput: true`, `supportsSessionDir: false`, `supportsPersistentStdin: false`, `verifiedAgainst: '<dsh --version output at implementation>'` (0.2.2-rc.1 at refine).
- `note` states: sessionDir false — session store is `$DSH_HOME`, an env var the argv-only shim cannot set; persistent stdin false — headless runs one task per process; resume requires the same cwd and repeated permission flags.
- Replace the stale 0.1.5-rc.1 doc comment above `dshShim` (`:416-423`), the inline comment in `getPromptCommand`, and the row comment (`:633`).

Fixtures (`packages/ai-runner/tests/fixtures/dsh/`):
- `completed.jsonl` — `--json` stdout of a run that ends `final.reason.kind: "completed"`, exit 0.
- `not-completed.jsonl` — `--json` stdout of a run that exits 1: preferred a SIGINT after the first `status` event (aborted reason or missing `final`); acceptable fallback is the `--session-id session-bogus` `error`-event stream (no `final`).
- `README.md` — provenance block in the `tests/fixtures/turn-drivers/pi/README.md` style: dsh version, capture date, exact command, exit code per file, redactions. Redact absolute paths (including the `session` event's `cwd`) and home to `<HOME>` and host-private prompt text; keep event `type`s, order and `final.reason` intact.
- The exit code per fixture lives in the README and in a constant in the test (no extra metadata file).

Rejected: an NDJSON event mapper in ai-runner (no ai-runner code parses agent stdout — `grep JSON.parse packages/ai-runner/src` hits only `model-health-probe.ts` and `quota.ts` — and the exit status already carries success); a new `PromptOptions` permission field (no current consumer needs a second mode); mapping `continue` to a session lookup (needs session-store reads, which the pure shim must not do); shim-side blank-input throw (dsh already rejects it pre-model, and no other shim validates input).
Invariants: the shim parses nothing and reads nothing (no fs, env, or credential access); the permission flags go on every call, resume included; `--` always immediately precedes the input, which is always the last argv element; the canonical id stays `deepseek` and the binary stays `dsh`.
Deferred: `--add-dir <git-common-dir>`. Condition: Spur task 1458 shows a dsh run must commit from a worktree; that needs a `PromptOptions` grant field, which is a facade API addition and gets its own task.
Handoff: Spur task 1456 consumes the published version; this task leaves the version bump to the operator.
Concurrency (2026-11-26): no `wip` tasks; one worktree (main). Unrelated uncommitted `.spur/config.yaml` change must be preserved.

### Plan

0. Precondition: `dsh --version` prints 0.2.x (0.2.2-rc.1 at refine). If it differs, re-run `dsh --profile headless --help` and re-check the flags in Design before coding.
1. Read `packages/ai-runner/src/agents/shims.ts` `ShimCommand` (:24), `PromptOptions` (:32), `grokShim` (:388), `dshShim` (:424), `fmShim` (:459), the `deepseek` capability row (:634), and the task 0066 tests (`packages/ai-runner/tests/agents/shims.test.ts:536-580`).
2. Capture fixtures (R3) from a scratch cwd outside the repo, outside the agent sandbox or with `DSH_HOME` pointing at a writable copy: `dsh --profile headless --json --permission-mode workspace-write --approval-policy never -- "<trivial task>" > completed.jsonl; echo $?`, then the not-completed run per Design. Redact, then write `tests/fixtures/dsh/README.md` with provenance. Credentials come from the operator's environment; never copy keys or `.env` into fixtures.
3. Write failing tests first in `tests/agents/shims.test.ts` `describe('deepseek shim …')`:
   - rewrite `:548` (one-shot argv → R1 frozen argv), `:555` (degrade → R4: `continue`/`sessionDir`/`model` produce the fresh argv; `sessionId` adds `--session-id`), `:568` (capability → R5 values);
   - add json-mode test (R2), dash-leading input test (`'-x'` stays after `--`, R1), keep `getAuthCommand` null / version / help tests (R6);
   - add the fixture test (R3): parse each `.jsonl`, find the `final` event, assert `kind === 'completed'` ⇔ the README-recorded exit code 0.
4. Update `dshShim` and the `deepseek` capability row to the frozen Design; replace the stale 0.1.5-rc.1 comments.
5. Optional cheap regression probe (no model call): `dsh --profile headless --permission-mode workspace-write --approval-policy never --session-id session-bogus -- "-x"` exits 1 with `does not exist`, not a usage error. Record it in Solution.
6. Run `bun run spur-check` and `bun run build`; `git status` shows only shim, test and fixture changes plus the pre-existing `.spur/config.yaml` edit.
7. Stop at the release: ask Robin to authorize `bun run bump-ver` and publish. Spur task 1456 consumes the published version.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- ts-libs feature `I1` (this task's feature), parent `I` (0.1.5 shim and importer); task 0066 (original shim)
- deepseek-harness source: `/Users/robin/xprojects/spur-new/vendors/deepseek-harness` (`@deepseek-ai/dsh-headless` 0.2.3-alpha.2, commit `4b399c39a6`, 2026-11-22; installed binary is 0.2.2-rc.1). Headless bundle `packages/bundle/headless/`:
  - `README.md` — contract: § Choosing the session identity, § Supervising implementation tasks, § Machine-readable output, § Help and task errors, § Exit mapping
  - `src/startup.ts` — CLI options (`:58-63`) and usage errors (`:123-146`)
  - `src/index.ts` — run flow and exit mapping (`:441`)
  - `src/json-stream.ts` — `--json` event projection; `session` (`:320`) and `final` (`:327`) events
  - `tests/headless.spec.ts` — exit 1 on non-completed turn (`:683`) and on no turn (`:735`); `--session-id` rejection (`:807`); `tests/json-stream.spec.ts` — event shapes for fixture checks
- spur repo (`~/xprojects/spur-new`): task 1456 (consumer bump), tasks 1457/1458, feature B81, ADR-153, `docs/design/dsh-agent-integration.md`

### History

- 2026-11-26T22:19:49.975Z backlog → todo (system)

