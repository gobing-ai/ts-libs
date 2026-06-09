---
name: make initializeLogger honor the setLoggerMuted flag so a muted logger stays silent across reconfigure
description: make initializeLogger honor the setLoggerMuted flag so a muted logger stays silent across reconfigure
status: Done
created_at: 2026-06-09T04:06:42.238Z
updated_at: 2026-06-09T04:14:37.710Z
folder: docs/tasks
type: task
feature-id: ""
impl_progress:
  planning: pending
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

## 0029. make initializeLogger honor the setLoggerMuted flag so a muted logger stays silent across reconfigure

### Background

`@gobing-ai/ts-infra`'s logger (`packages/infra/src/logger.ts`) has **two independent
silence mechanisms** that were inconsistent:

1. **`setLoggerMuted(value)`** — flips a module-level `muted` flag that every
   `LogTapeLogger` method checks before delegating (`if (!muted) this.inner.info(...)`).
   Synchronous, global, and **independent of LogTape's sink config**.
2. **`initializeLogger(options)`** — `reset()`s LogTape then `configure()`s sinks
   (console + optional injected file sink). The doc-comment notes it is "safe to call
   again to reconfigure — the latest call wins."

The gap: `initializeLogger` did **not** consult `muted`. So this sequence resurfaced output
a caller had explicitly silenced:

```ts
setLoggerMuted(true);              // test harness mutes everything at preload
// … later …
await initializeLogger({ ... });   // an app bootstrap reconfigures → reinstalls console sink
getLogger('x').info('leak');       // muted flag is checked, BUT the record still reaches
                                   // the reinstalled console sink? No — the muted gate is
                                   // per-instance; see "real-world trigger" below.
```

**Real-world trigger (downstream, spur-new task 0029).** A spur-cli test harness mutes logging
once at preload via `setLoggerMuted(true)` + a no-sink LogTape `configure()`. Any test that runs
the CLI bootstrap (`main()` → `runNodeApplication` → `initializeLogger`) reconfigured LogTape with
a console JSON sink, wiping the harness's no-sink config. Because the leaking logs originated from
a sibling package (`ts-rule-engine`) that — at the time — resolved a *different* ts-infra instance
whose `muted` flag was still `false`, ~42 JSON log lines leaked to stdout during the test run.
Deduping ts-infra to a single version fixed the instance split, but the **design inconsistency
remained**: `setLoggerMuted(true)` should be a true global kill-switch that survives any later
`initializeLogger`, so no downstream consumer needs a per-app workaround (spur-cli currently carries
a `NODE_ENV === 'test'` logging-off branch in `main()` that this fix lets it remove).

### Requirements

- **R1 — `initializeLogger` honors `muted`.** When `muted === true`, `initializeLogger` installs
  **no sinks** (neither console nor the injected file sink) regardless of the `console`/`fileSink`
  options. The LogTape `configure()` still runs (category/level rules stay valid) but with an empty
  sink set, so nothing emits.
- **R2 — Mute is not permanent.** After `setLoggerMuted(false)`, a subsequent `initializeLogger`
  re-installs the requested sinks normally. Muting only suppresses sink wiring *while* the flag is
  set; it does not poison future configs.
- **R3 — No behavior change when not muted.** With `muted === false` (the default), `initializeLogger`
  behaves exactly as before — same console/file sink wiring, same level rules.
- **R4 — Regression test.** A test proves the trigger sequence: `setLoggerMuted(true)` →
  `initializeLogger({ console: true, fileSink })` → emit → **zero** output; then unmute + reconfigure
  → output restored.
- **R5 — Gates green.** `bun run lint` + full `bun run test` pass; `logger.ts` coverage stays 100%.

### Q&A

**Q1: Why not just rely on the per-method `muted` gate?** The adapter gate works for loggers
created from *this* ts-infra instance, but it is checked in the `LogTapeLogger` wrapper, not in
LogTape itself. Records from any code path that reaches LogTape's sinks through a different route
(or a different ts-infra instance pre-dedup) bypass it. Making `initializeLogger` install no sinks
while muted closes the hole at the sink layer — defense in depth, and the single obvious place a
"silence everything" intent should be enforced.

**Q2: Should `setLoggerMuted(true)` also tear down already-configured sinks?** Out of scope here.
The flag already gates emission at the adapter; this task only ensures a *future* `initializeLogger`
doesn't reinstall sinks while muted. Live teardown-on-mute would be a larger change with no current
consumer need.

**Q3: Release timing?** Accumulate with other ts-infra changes; do **not** release immediately
(Robin, 2026-06-09). The downstream spur-cli `NODE_ENV` workaround stays until this ships, then
is reverted.

### Design

Single-point change in `initializeLogger` (`packages/infra/src/logger.ts`): guard both sink
installations on `!muted`.

```ts
const sinks: Record<string, Sink> = {};
if (!muted && enableConsole) {
    sinks.console = getConsoleSink({ formatter });
}
if (!muted && fileSink) {
    sinks.file = (record: LogRecord) => {
        fileSink(formatter(record));
    };
}
// reset() + configure() unchanged — runs with an empty sink set when muted.
```

`configure()` still registers the `[ROOT_CATEGORY]` and `['logtape','meta']` logger rules with
`sinks: Object.keys(sinks)` (empty when muted), so the config remains valid and the next
`initializeLogger` after unmute restores sinks cleanly.

### Solution

**Chosen approach:** Make `initializeLogger` treat `muted` as authoritative over sink wiring — the
minimal change that unifies the two mute mechanisms. Rejected: (a) tearing down sinks inside
`setLoggerMuted` (larger, no consumer need, Q2); (b) leaving it downstream (every ts-infra consumer
re-implements a per-app logging-off workaround — exactly what this removes).

### Plan

1. Guard both sink installs in `initializeLogger` on `!muted` (`packages/infra/src/logger.ts`). ✅
2. Add regression test in `packages/infra/tests/logger.test.ts`: muted reconfigure emits nothing;
   unmute + reconfigure restores output (R4). ✅
3. Gate: `bun run lint` + full `bun run test`; confirm `logger.ts` 100% coverage. ✅
4. (Downstream, not this repo) After release, revert the spur-cli `main()` `NODE_ENV` logging-off
   branch and rely on `setLoggerMuted(true)` alone.

**Gate:** ts-libs `lint` + `test` green; clean `git status`.

### Review

**Verdict:** PASS | **Status:** Implemented + verified 2026-06-09. All requirements MET. Not yet released
(accumulating with other ts-infra changes per Robin).

- R1 — MET | `packages/infra/src/logger.ts:126-141` — both sink installs guarded on `!muted`.
- R2 — MET | regression test asserts output restored after `setLoggerMuted(false)` + reconfigure.
- R3 — MET | `muted === false` path is byte-identical to prior behavior; all 8 prior logger tests pass.
- R4 — MET | `logger.test.ts` new test `initializeLogger installs no sinks while muted …`.
- R5 — MET | `bun run lint` clean; `bun run test` 1266 pass / 0 fail; `logger.ts` 100% funcs / 100% lines.

### Testing

**Verified 2026-06-09.**
- `bun test packages/infra/tests/logger.test.ts` → 9 pass / 0 fail; `logger.ts` 100%/100%.
- New regression test covers the exact trigger: `setLoggerMuted(true)` →
  `initializeLogger({ console: true, fileSink })` → emit → 0 lines captured; then
  `setLoggerMuted(false)` → reconfigure → 1 line captured.
- Full ts-libs suite: `bun run test` → 1266 pass / 0 fail; `bun run lint` → typecheck clean
  across all packages.

### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |
| fix | `packages/infra/src/logger.ts` | claude-opus-4-8 | 2026-06-09 |
| test | `packages/infra/tests/logger.test.ts` | claude-opus-4-8 | 2026-06-09 |

### References

- **Downstream bug that motivated this:** `~/xprojects/spur-new` task `0029` Q&A + `.wolf/buglog.json` `bug-238` (test-output leak; `app.rule-engine` JSON lines).
- **Spur-side workaround to revert after release:** `apps/cli/src/index.ts` `main()` — `config: process.env.NODE_ENV === 'test' ? { logging: { enabled: false } } : undefined`.
- **Source:** `packages/infra/src/logger.ts` (`initializeLogger`, `setLoggerMuted`, `LogTapeLogger`).


