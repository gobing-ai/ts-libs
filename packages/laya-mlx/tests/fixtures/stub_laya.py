"""Minimal stand-in for ``laya_mlx.Agent`` used by the worker protocol tests.

Mirrors the constructor surface and ``predict`` contract the worker relies on —
question validation, batch-size chunking, and the non-finite-output error — with
no MLX, no checkpoint, and no network, so the protocol fixture layer runs in the
default test lane (docs/design/laya-local-decision-backend.md).

Deterministic hooks for the process-client tests (0076), keyed on values a real
runtime would never see:

- ``model_id == 'stub/slow-start'`` — construction sleeps ``delaySeconds``
  (default 30) so a client handshake budget can expire.
- question ``instructions == 'slow'`` — ``predict`` sleeps ``delaySeconds``
  (default 30) so a client request budget can expire while the worker stays up.
- question ``instructions == 'die'`` — ``predict`` exits the process (code 7)
  mid-request so client death-handling is observable.
- env ``LAYA_PARENT_SENTINEL`` — construction fails; proves the child did not
  inherit the parent environment wholesale (0076 R5).
- ``usage`` carries ``pid`` so warm-reuse vs respawn is observable.
"""

import os
import time

DTYPES = ("float32", "float16", "bfloat16")
QTYPE_NAMES = ("choice", "score", "noul")


def _delay(definition):
    raw = definition.get("delaySeconds", 30)
    return float(raw) if not isinstance(raw, bool) else 30.0


class Agent:
    def __init__(
        self,
        model_id_or_path="stub/laya",
        device=None,
        token=None,
        subfolder=None,
        *,
        dtype="float16",
        revision=None,
        batch_size=16,
        compile=False,
        pad_to_multiple=None,
        cache_prompts=False,
    ):
        if dtype not in DTYPES:
            raise ValueError(f"dtype must be one of {list(DTYPES)}")
        if not isinstance(batch_size, int) or isinstance(batch_size, bool) or batch_size < 1:
            raise ValueError("batch_size must be a positive integer")
        if os.environ.get("LAYA_PARENT_SENTINEL") is not None:
            raise ValueError("parent environment leaked into the worker")
        self.model_id = str(model_id_or_path)
        self.revision = revision
        self.batch_size = batch_size
        self.cfg = {"max_len": 512}
        if self.model_id == "stub/slow-start":
            time.sleep(30.0)

    def predict(self, state, questions):
        if not isinstance(state, str):
            raise ValueError("state must be a string")
        if not isinstance(questions, dict) or not questions:
            raise ValueError("questions must be a nonempty dictionary keyed by question id")
        answers = {}
        question_ids = list(questions)
        chunks = 0
        for start in range(0, len(question_ids), self.batch_size):
            chunks += 1
            for qid in question_ids[start : start + self.batch_size]:
                definition = questions[qid]
                if not isinstance(definition, dict):
                    raise ValueError("Each question must be a dictionary")
                kind = definition.get("type")
                if kind not in QTYPE_NAMES:
                    raise ValueError(f"Unknown question type {kind!r}; expected choice, score, or noul")
                if "instructions" not in definition:
                    raise ValueError("Question is missing instructions")
                if definition["instructions"] == "boom":
                    raise FloatingPointError("Non-finite model outputs; retry with dtype='float32'")
                if definition["instructions"] == "slow":
                    time.sleep(_delay(definition))
                if definition["instructions"] == "die":
                    os._exit(7)
                if kind == "choice":
                    raw_labels = definition.get("labels", definition.get("criteria", {}))
                    labels = list(raw_labels.keys()) if isinstance(raw_labels, dict) else list(raw_labels)
                    first_label = labels[0] if labels else "choice"
                    probs = {l: round(1.0 / len(labels), 4) for l in labels} if labels else {first_label: 1.0}
                    answers[qid] = {
                        "type": "choice",
                        "choice": first_label,
                        "confidence": 0.95,
                        "probabilities": probs,
                        "action": {"act_probability": 0.8},
                    }
                elif kind == "score":
                    rubric = definition.get("rubric", definition.get("criteria", ["0", "1"]))
                    count = len(rubric) if isinstance(rubric, (list, tuple)) else len(rubric.keys())
                    probs = {i: round(1.0 / count, 4) for i in range(count)}
                    legend = {i: f"level {i}" for i in range(count)}
                    answers[qid] = {
                        "type": "score",
                        "score": 0,
                        "confidence": 0.9,
                        "probabilities": probs,
                        "legend": legend,
                        "action": {"act_probability": 0.8},
                    }
                elif kind == "noul":
                    answers[qid] = {
                        "type": "noul",
                        "noul": 0.75,
                        "confidence": 0.75,
                        "action": {"act_probability": 0.8},
                    }
                else:
                    answers[qid] = {"type": kind, "confidence": 0.5}
        return {
            "model": "stub-laya",
            "answers": answers,
            "usage": {
                "input_tokens": len(question_ids) * 7,
                "output_tokens": 0,
                "chunks": chunks,
                "pid": os.getpid(),
            },
        }


RLAgent = Agent
