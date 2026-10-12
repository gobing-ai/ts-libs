# changelog-verification-confidence rule fixtures

Fixtures for the `changelog-verification-confidence` rule
(`.spur/rules/quality/changelog-verification-confidence.yaml`).

Each case is a whole `CHANGELOG.md`, because the rule reads the one file at the workdir root
rather than receiving a file list: the case directory carries the id, and the file inside it always
stages as `CHANGELOG.md`.

- `should-fire/` — the record in that file must be reported, with its reason named.
- `should-pass/` — the file must be silent.

The rule asserts the confidence *enum*, not the surrounding prose: the level must be present and it
must be spelled `HIGH`, `MEDIUM` or `LOW`. Both halves are pinned below.

Inputs to an automated gate: `bun run verify-rule-fixtures` (`scripts/verify-rule-fixtures.ts`) is
wired into `test-post-check`, so `bun run spur-check` stages every `CHANGELOG.md` below into a
scratch workdir and re-evaluates it through the real `RuleEngine`. It fails the command on any
mismatch, and it fails — rather than skips — on a deleted `should-fire`/`should-pass` directory or
an unrecognized fixture shape.

## What each fixture pins

| Fixture | Asserts |
|---------|---------|
| `should-fire/0101-level-absent` | a record with no `confidence` clause is rejected as declaring no level |
| `should-fire/0102-level-lowercase` | `confidence high` is rejected — the spelling, not the intent, is the contract |
| `should-fire/0103-level-non-enum` | a level-shaped word that is not one of the three (`confidence sure`) does not satisfy presence |
| `should-fire/0104-miscased-beside-valid` | `confidence low` is rejected **even though** the same record spells `confidence HIGH` correctly elsewhere |
| `should-pass/0201-high` | a correctly spelled `HIGH` record is accepted |
| `should-pass/0202-medium` | `MEDIUM` is accepted — the enum is three levels, not "HIGH or nothing" |
| `should-pass/0203-low` | `confidence level LOW` is accepted, so the optional `level` word is not a spelling failure |
| `should-pass/0204-prose-mentions` | a `HIGH` record whose prose also mentions `verify-confidence.yaml`, `confidence check`, `confidence rule`, `low confidence` and a `confidence MEDIUM` counterfactual stays silent |
| `should-pass/0205-keyword-case-and-colon` | `Confidence: HIGH` is accepted — the keyword is matched case-insensitively and a `:` separator is a spelling this repository already uses in its answer files, so it must not read as no level at all |

`0104` is the load-bearing one for the spelling half: it fails a record that a
"one valid level is enough" implementation would accept. `0204` is load-bearing for the other half:
it pins what the rule deliberately does **not** assert (see Known limits), so widening the rule is a
conscious fixture change rather than an accident.

## Reproducing one rule by hand

The exit-code evaluator reports ONE finding for a non-zero exit, so the per-record reasons are the
script's stdout — read them directly.

```bash
RULE="$(git rev-parse --show-toplevel)/.spur/rules/quality/changelog-verification-confidence.yaml"
SRC="$(git rev-parse --show-toplevel)/.spur/rules/fixtures/changelog-verification"

python3 - "$RULE" > /tmp/changelog-verification-confidence.sh <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
sys.stdout.write(d["rules"][0]["evaluator"]["config"]["args"][1])
PY

for d in "$SRC"/should-*/*/; do
  TMP="$(mktemp -d)"; cp "$d/CHANGELOG.md" "$TMP/CHANGELOG.md"
  out="$(cd "$TMP" && sh /tmp/changelog-verification-confidence.sh 2>&1)"; code=$?
  echo "$(basename "$d") exit=$code ${out:+— $out}"
  rm -rf "$TMP"
done
```

## Known limits

- **A CHANGELOG carrying no verification record passes.** The records are the subject, so deleting
  every one leaves nothing to check — the same shape as `verify-confidence-level`, whose subject
  plane is likewise absent in a clean checkout.
- **Only the enum is asserted.** Whether a `HIGH` claim is *earned* is not checked here: a record's
  evidence is prose, and the machine-checkable half of that contract belongs to the verdict
  artifacts the record cites, where `verify-confidence-level` enforces it (`0106`: `HIGH` resting on
  `manual-review`).
- **Two different levels in one record are not rejected.** `0204` passes with a `HIGH` clause and a
  `confidence MEDIUM` mention in its assertion coverage, because a record legitimately discusses the
  weaker levels it rejected. Adding level agreement would be a rule change: that fixture moves to
  `should-fire/` in the same commit.
