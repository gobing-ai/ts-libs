# laya-mlx worker

Long-lived Python worker that executes the vendored `laya-mlx` runtime as a
JSON-lines process bridge (ADR-027). `laya_worker.py` constructs one `Agent`
and serves the line protocol for the lifetime of the process; the TypeScript
client lands in the process-bridge task that follows.

## Running

```sh
python3 worker/laya_worker.py [--model <hf-id>] [--model-path <dir>]
                              [--revision <rev>] [--dtype float16]
                              [--batch-size 16] [--cache-dir <dir>]
```

Construction options may instead arrive as the first stdin line,
`{"options": {"model": …, "modelPath": …, "revision": …, "dtype": …,
"batchSize": …, "cacheDir": …}}`; a first line without an `"options"` key is
served as the first request. `--cache-dir` is exported as `HF_HUB_CACHE` before
the runtime import; `HF_TOKEN` from the environment reaches the runtime for
gated repositories.

## Line protocol

One JSON object per line, UTF-8, LF-delimited, both directions. Every response
is flushed immediately.

| Direction | Line |
|-----------|------|
| handshake (once, first) | `{"ready": true, "model": "…", "revision": "…\|null", "maxLen": 512}` |
| startup failure (once, first) | `{"ready": false, "error": {"kind": "config", "message": "…"}}`, exit 1 |
| request | `{"id": "…", "state": "…", "questions": {"<qid>": {…}}}` |
| success | `{"id": "…", "ok": true, "result": <runtime predict payload>}` |
| failure | `{"id": "…", "ok": false, "error": {"kind": "config\|request\|backend", "message": "…"}}` |

Error kinds: `config` — construction/host problems; `request` — malformed line
or malformed question; `backend` — model problems (e.g. non-finite outputs).
The worker survives request failures; only startup failure ends the process.

The worker contains no model logic: tokenization, batching, calibration, and
answer construction all belong to the installed runtime. A request carrying
more questions than the batch size is chunked inside `Agent.predict`, and every
answer is returned keyed by its question name. The authoritative contract is
[`docs/design/laya-local-decision-backend.md`](../../../docs/design/laya-local-decision-backend.md);
supported runtime version range lives in the [package README](../README.md).
