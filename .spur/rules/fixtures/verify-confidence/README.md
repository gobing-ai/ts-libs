# verify-confidence-level rule fixtures

Fixtures for the `verify-confidence-level` rule
(`.spur/rules/quality/verify-confidence.yaml`). Each fixture is a whole
`.spur/run/` (or `.spur/memory/evidence/`) tree, because the rule globs its own
subject relative to the workdir rather than receiving a file list.

- `should-fire/` — each file must be reported, with the reason named for that file.
- `should-pass/` — each file must be silent.

Inputs to an automated gate: `bun run verify-rule-fixtures` (`scripts/verify-rule-fixtures.ts`) is
wired into `test-post-check`, so `bun run spur-check` stages every verdict JSON below into a scratch
workdir and re-evaluates it through the real `RuleEngine`. It fails the command on any mismatch, and
it fails — rather than skips — on a deleted `should-fire`/`should-pass` directory or an
unrecognized fixture shape.

## What each fixture pins

| Fixture | Asserts |
|---------|---------|
| `should-fire/0101` | a proof-bound verdict with **no** `confidence` key is rejected |
| `should-fire/0102` | a misspelled level (`"high"`) is rejected, not coerced |
| `should-fire/0103` | `HIGH` launder: a non-`pass` check beside a `HIGH` claim is rejected |
| `should-fire/0104` | the recorded `confidence` check disagreeing with the level is rejected |
| `should-fire/0105` | a malformed `evidenceType` (`test+static`) is rejected **without** a proof block — the vocabulary check is not proof-scoped |
| `should-fire/0106` | `HIGH` resting on self-attestation (`manual-review`) is rejected |
| `should-fire/0107` | a `MEDIUM` level with no `confidence` check at all is rejected as unacknowledged |
| `should-fire/0108` | a `MEDIUM` level whose recorded check omits `(operator-acknowledged)` is rejected |
| `should-pass/0201` | `HIGH` with every check `pass` and an agreeing check is accepted |
| `should-pass/0202` | `MEDIUM` **may** sit beside a non-`pass` check (only `HIGH` is exclusive), and is accepted **because** its check carries `(operator-acknowledged)` |
| `should-pass/0203` | a verdict with no `proof` block is out of scope for the level checks — legacy, not suppressed |
| `should-pass/0204` | the durable `.spur/memory/evidence/` plane is scanned too |
| `should-pass/0205` | a **valid** compound (`static-ref+test`) is accepted — the check rejects bad tokens, not compounds |
| `should-pass/0206` | `HIGH` earned by `test`/`command` rows, with an explicit `n/a` row correctly excluded |
| `should-fire/0109` | a contract-bound **feature-verification receipt** with no `confidence` key is rejected |
| `should-fire/0110` | a misspelled feature level (`"high"`) is rejected, not coerced |
| `should-fire/0111` | `HIGH` on a feature receipt whose pass ran a **narrowed** command is rejected |
| `should-fire/0112` | a `FAIL` feature receipt carrying `MEDIUM` is rejected (a non-pass certifies nothing) |
| `should-fire/0113` | `HIGH` with no `confidenceBasis` is rejected — the level must say what it proved |
| `should-fire/0114` | a feature pass **started on or after 2026-10-19** with no confidence level is rejected (the cutover is the migration boundary) |
| `should-pass/0207` | a feature receipt at `HIGH` from the full gate is accepted |
| `should-pass/0208` | `MEDIUM` is the honest level for a narrowed command, and is accepted |
| `should-pass/0209` | a pre-cutover receipt (no `confidenceContract`, started 2026-09-24) is historical — out of scope, not suppressed |

Feature-receipt cases (`0109`-`0114`, `0207`-`0209`) pin the second subject plane, and `0114`/`0209`
are its scope pair: post-cutover passes must record a level, earlier ones are history. The level there is
written by the project driver (`.spur/scripts/feature-verify.mjs`) from what the pass actually ran —
`HIGH` only for the full gate, `MEDIUM` for a narrowed `--cmd`, `LOW` for a non-pass — so the rule
checks a derived claim rather than a self-assignment. `0209` is the scope fixture, `0111`/`0112` are
the two ways a level can overstate a receipt.

`0203` is the load-bearing one for scope, and `0105`/`0205` are the pair that
pin the vocabulary check's own scope: `0105` proves it reaches artifacts without
a proof block, `0205` proves it does not simply reject every `+` compound. The
level and substance checks stay proof-bound; the vocabulary check does not.

## Reproducing one rule by hand

Still useful for a fast answer on a single rule edit. Run from a scratch copy so the rule runner's
SQLite artifacts stay out of the repo; the fixture's own subject plane is preserved by copying the
whole expectation directory:

```bash
RULE="$(git rev-parse --show-toplevel)/.spur/rules/quality/verify-confidence.yaml"
SRC="$(git rev-parse --show-toplevel)/.spur/rules/fixtures/verify-confidence"

# The exit-code evaluator reports ONE finding for a non-zero exit, so the
# per-file reasons are the script's stdout — read them directly.
python3 - "$RULE" > /tmp/verify-confidence.sh <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
sys.stdout.write(d["rules"][0]["evaluator"]["config"]["args"][1])
PY

echo "--- should-fire: each file exits 1 and names its own reason ---"
for f in "$SRC"/should-fire/.spur/run/*-verdict.json; do
  TMP="$(mktemp -d)"; mkdir -p "$TMP/.spur/run"; cp "$f" "$TMP/.spur/run/"
  (cd "$TMP" && sh /tmp/verify-confidence.sh); echo "  $(basename "$f") exit=$?"
  rm -rf "$TMP"
done

echo "--- should-pass: whole set exits 0 with no output ---"
TMP="$(mktemp -d)"; cp -R "$SRC/should-pass/." "$TMP/"
(cd "$TMP" && sh /tmp/verify-confidence.sh); echo "  exit=$?"
rm -rf "$TMP"
```

Via the real preset the rule surfaces a single finding whose detail is the
script's stdout — use `spur rule run --preset recommended-post-check --verbose`
to stream it.

## Known limits

- **The subject plane is untracked.** `.spur/run/` and `.spur/memory/evidence/`
  are gitignored, so in a clean checkout or CI there is nothing to verify and the
  rule passes.
- **Feature receipts are contract- and date-scoped.** A receipt with
  `confidenceContract: 1` is level-checked; one without it must predate
  `2026-10-19`, the cutover the project pass started stamping. A receipt written
  by a tool that bypasses the project adapter after that date is reported with the
  remedy (`bun .spur/scripts/feature-verify.mjs verify --feature-id <id>`).
- **An in-flight pass is exempt.** The receipt is written `RUNNING` before the
  gate runs, so the gate would otherwise fail its own pass; `RUNNING` receipts are
  skipped and the completed one is checked. It bites on the developer's machine, immediately after a pipeline
  run — which is where a miscategorised level is actionable.
- **The level and substance checks apply to proof-bound verdicts only**, so today
  they have one subject in this repo. The vocabulary check is the one with broad
  reach: it reads all 84 artifacts and caught three malformed tokens
  (`test+static`, `static+command`) that had sat unread in two of them.
- **A recorded `confidence` check is optional for a HIGH level** — the agreement
  assertion only fires when one exists, because the pipeline writes the check as
  a `warn` row for weaker levels and a `pass` row for HIGH. For a **non-HIGH**
  level the check is required and must carry `(operator-acknowledged)`: that
  marker is written only when the operator actually accepted the weaker level, so
  its absence means the level was self-assigned. Fixtures `0107`/`0108` pin both
  halves of that.
