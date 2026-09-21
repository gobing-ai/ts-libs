#!/usr/bin/env python3
"""Long-lived JSON-lines worker around the installed ``laya_mlx`` runtime (ADR-027).

Lifecycle: resolve options (CLI args, else the first stdin line) -> import the runtime
module -> construct one Agent -> emit the handshake -> serve one JSON object per line
until EOF. The worker owns lifecycle and framing only: tokenization, batching,
calibration, and answer construction are the runtime's (``Agent.predict``). A request
carrying more questions than the configured batch size is chunked inside the runtime;
every answer is returned keyed by its question name.

Line protocol (docs/design/laya-local-decision-backend.md):

    handshake  {"ready": true, "model": "...", "revision": "...|null", "maxLen": N}
    request    {"id": "...", "state": "...", "questions": {"<qid>": {...}}}
    success    {"id": "...", "ok": true, "result": <runtime predict payload>}
    failure    {"id": "...", "ok": false, "error": {"kind": "config|request|backend", "message": "..."}}
    startup    {"ready": false, "error": {"kind": "config", "message": "..."}} then exit 1

Error kinds: ``config`` — construction/host problems (model resolution, dtype, batch
size); ``request`` — caller problems (malformed line, malformed question); ``backend``
— model problems (non-finite outputs, unexpected runtime failure).
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import sys

DEFAULT_MODULE = "laya_mlx"


def parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="laya_worker.py",
        description="JSON-lines worker executing one laya_mlx.Agent for its lifetime.",
    )
    parser.add_argument("--model", default=None, help="Hugging Face model id")
    parser.add_argument("--model-path", default=None, help="local checkpoint directory (wins over --model)")
    parser.add_argument("--revision", default=None, help="checkpoint revision")
    # dtype/batch-size are validated by the runtime's Agent constructor so a bad
    # value surfaces as the structured config handshake, not an argparse exit.
    parser.add_argument("--dtype", default="float16", help="weight precision")
    parser.add_argument("--batch-size", type=int, default=16, help="questions per forward pass")
    parser.add_argument("--cache-dir", default=None, help="artifact cache root (exported as HF_HUB_CACHE)")
    parser.add_argument(
        "--module",
        default=DEFAULT_MODULE,
        help="runtime module to import (default: laya_mlx); a non-default module is "
        "resolved from the working directory so tests can inject a stub",
    )
    return parser.parse_args(argv)


def merge_first_line_options(args, line):
    """Apply construction options from a first line of ``{"options": {...}}``.

    Returns ``(args, applied)``. ``applied`` is False when the line is absent,
    unparsable, or an ordinary request — in every case the caller must still
    serve the line so no request is ever dropped.
    """
    if line is None or not line.strip():
        return args, False
    try:
        parsed = json.loads(line)
    except json.JSONDecodeError:
        return args, False
    if not isinstance(parsed, dict) or not isinstance(parsed.get("options"), dict):
        return args, False
    supplied = parsed["options"]
    if "model" in supplied:
        args.model = supplied["model"]
    if "modelPath" in supplied:
        args.model_path = supplied["modelPath"]
    if "revision" in supplied:
        args.revision = supplied["revision"]
    if "dtype" in supplied:
        args.dtype = supplied["dtype"]
    if "batchSize" in supplied:
        args.batch_size = supplied["batchSize"]
    if "cacheDir" in supplied:
        args.cache_dir = supplied["cacheDir"]
    return args, True


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def startup_failure(message):
    emit({"ready": False, "error": {"kind": "config", "message": message}})


def build_agent(args):
    module_name = args.module
    if module_name != DEFAULT_MODULE:
        # Test seam: resolve an injected module from the working directory.
        sys.path.insert(0, os.getcwd())

    # huggingface_hub reads cache locations at import time, so the cache root must
    # be exported before the import below; it is config plumbing, not model logic.
    if args.cache_dir:
        os.environ["HF_HUB_CACHE"] = args.cache_dir

    module = importlib.import_module(module_name)
    agent_cls = getattr(module, "Agent")

    model = args.model_path or args.model
    kwargs = {}
    if model is not None:
        kwargs["model_id_or_path"] = model
    if args.revision is not None:
        kwargs["revision"] = args.revision
    kwargs["dtype"] = args.dtype
    kwargs["batch_size"] = args.batch_size
    kwargs["token"] = os.environ.get("HF_TOKEN")
    return agent_cls(**kwargs)


def request_error(request_id, message):
    return {"id": request_id, "ok": False, "error": {"kind": "request", "message": message}}


def classify(exc):
    """Map a runtime exception onto the protocol's error taxonomy."""
    if isinstance(exc, FloatingPointError):
        return "backend"
    if isinstance(exc, ValueError):
        return "request"
    return "backend"


def handle_request(agent, line):
    try:
        request = json.loads(line)
    except json.JSONDecodeError as exc:
        return request_error("", f"malformed JSON line: {exc}")
    if not isinstance(request, dict):
        return request_error("", "request line must be a JSON object")
    if "id" not in request:
        return request_error("", "request is missing id")
    request_id = request["id"]
    if isinstance(request_id, bool) or not isinstance(request_id, (str, int)):
        return request_error("", "request id must be a string or integer")

    state = request.get("state")
    if not isinstance(state, str):
        return request_error(request_id, "request state must be a string")
    questions = request.get("questions")
    if not isinstance(questions, dict) or not questions:
        return request_error(request_id, "request questions must be a nonempty object")

    try:
        result = agent.predict(state, questions)
    except Exception as exc:  # classified and reported, never fatal to the worker
        return {"id": request_id, "ok": False, "error": {"kind": classify(exc), "message": str(exc)}}
    return {"id": request_id, "ok": True, "result": result}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else list(argv)
    args = parse_args(argv)

    # Without CLI args the construction options may arrive on the first stdin line;
    # a first line that is not an options line is the first request and must be served.
    pending_line = None
    if not argv:
        first_line = sys.stdin.readline().rstrip("\n")
        args, applied = merge_first_line_options(args, first_line)
        if not applied:
            pending_line = first_line

    try:
        agent = build_agent(args)
    except Exception as exc:  # every construction failure is config
        startup_failure(str(exc))
        return 1

    emit(
        {
            "ready": True,
            "model": str(agent.model_id),
            "revision": agent.revision,
            "maxLen": int(agent.cfg.get("max_len", 512)),
        }
    )

    def input_lines():
        if pending_line is not None:
            yield pending_line
        for line in sys.stdin:
            yield line.rstrip("\n")

    for line in input_lines():
        if not line.strip():
            continue
        try:
            emit(handle_request(agent, line))
        except BrokenPipeError:
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
