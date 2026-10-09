# verify-confidence-level rule fixtures

Fixtures for the `verify-confidence-level` rule
(`.spur/rules/quality/verify-confidence.yaml`). Each fixture is a whole
`.spur/run/` (or `.spur/memory/evidence/`) tree, because the rule globs its own
subject relative to the workdir rather than receiving a file list.

- `should-fire/` — each file must be reported, with the reason named for that file.
- `should-pass/` — each file must be silent.

Not part of any automated gate: they live under `.spur/`, and the rule reads
`.spur/run/` + `.spur/memory/evidence/` in whatever tree it runs in, so a
normal `bun run spur-check` never sees them.

## What each fixture pins

| Fixture | Asserts |
|---------|---------|
| `should-fire/0101` | a proof-bound verdict with **no** `confidence` key is rejected |
| `should-fire/0102` | a misspelled level (`"high"`) is rejected, not coerced |
| `should-fire/0103` | `HIGH` launder: a non-`pass` check beside a `HIGH` claim is rejected |
| `should-fire/0104` | the recorded `confidence` check disagreeing with the level is rejected |
| `should-pass/0201` | `HIGH` with every check `pass` and an agreeing check is accepted |
| `should-pass/0202` | `MEDIUM` **may** sit beside a non-`pass` check (only `HIGH` is exclusive) |
| `should-pass/0203` | a verdict with no `proof` block is out of scope — legacy, not suppressed |
| `should-pass/0204` | the durable `.spur/memory/evidence/` plane is scanned too |

`0203` is the load-bearing one for scope: it proves the rule's proof-block
boundary is a real boundary rather than a file the rule fails to look at.

## Reproducing

Run from a scratch copy so the rule runner's SQLite artifacts stay out of the repo:

```bash
RULE="$(git rev-parse --show-toplevel)/.spur/rules/quality/verify-confidence.yaml"
SRC="$(git rev-parse --show-toplevel)/.spur/rules/fixtures/verify-confidence"

# The exit-code evaluator reports ONE finding for a non-zero exit, so the
# per-file reasons are the script's stdout — read them directly.
extract() {
  python3 - "$RULE" <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
sys.stdout.write(d["rules"][0]["evaluator"]["config"]["args"][1])
PY
}
extract > /tmp/verify-confidence.sh

echo "--- should-fire: each file must exit 1 and name its own reason ---"
for f in "$SRC"/should-fire/.spur/run/*-verdict.json; do
  TMP="$(mktemp -d)"; mkdir -p "$TMP/.spur/run"; cp "$f" "$TMP/.spur/run/"
  (cd "$TMP" && sh /tmp/verify-confidence.sh); echo "  $(basename "$f") exit=$?"
  rm -rf "$TMP"
done

echo "--- should-pass: whole set must exit 0 with no output ---"
TMP="$(mktemp -d)"; cp -R "$SRC/should-pass/." "$TMP/"
(cd "$TMP" && sh /tmp/verify-confidence.sh); echo "  exit=$?"
rm -rf "$TMP"
```

Via the real preset the rule surfaces a single finding whose detail is the
script's stdout — use `spur rule run --preset recommended-post-check --verbose`
to stream it.

## Known limit

The subject plane (`.spur/run/`, `.spur/memory/evidence/`) is untracked, so in a
clean checkout or CI there is nothing to verify and the rule passes. It bites on
the developer's machine, immediately after a pipeline run — which is where a
miscategorised confidence level is actionable.
