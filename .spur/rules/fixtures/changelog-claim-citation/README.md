# changelog-claim-citation rule fixtures

Fixtures for the `changelog-claim-citation` rule
(`.spur/rules/quality/changelog-claim-citation.yaml`).

Each case is a whole `CHANGELOG.md`, because the rule reads the one file at the workdir root
rather than receiving a file list: the case directory carries the id, and the file inside it always
stages as `CHANGELOG.md`.

- `should-fire/` — the claim bullet in that file must be reported, with its reason named.
- `should-pass/` — the file must be silent.

The assertion is per bullet, and it is **presence of exactly one citation comment carrying an
anchor** — not "the changelog mentions a path somewhere". A bullet is a claim when it matches the
closed marker set the verdict-plane `evidence-citation` rule uses (a scoped-package mention, a
`node_modules/` reference, a semver claim, or a backticked function-call-shaped token); an anchor is
a URL, a repo path (`path` or `path:line`, a range allowed), or a backticked root-file name.

Inputs to an automated gate: `bun run verify-rule-fixtures` (`scripts/verify-rule-fixtures.ts`) is
wired into `test-post-check`, so `bun run spur-check` stages every `CHANGELOG.md` below into a
scratch workdir and re-evaluates it through the real `RuleEngine`. It fails the command on any
mismatch, and it fails — rather than skips — on a deleted `should-fire`/`should-pass` directory or
an unrecognized fixture shape.

## What each fixture pins

| Fixture | Asserts |
|---------|---------|
| `should-fire/0101-claim-without-citation` | a claim bullet carrying no `<!-- src: … -->` at all is reported, while the bookkeeping bullet beneath it (no claim marker) stays silent |
| `should-fire/0102-citation-without-anchor` | a citation whose body names no anchor (`see the implementation`) is reported — presence of the comment is not presence of evidence |
| `should-fire/0103-duplicate-citation` | two citations on one claim bullet are reported — the contract is exactly one, so a second comment cannot dilute which anchor proved what |
| `should-pass/0201-path-line-anchor` | a `path:line` anchor accepts the bullet, in a **dated** contract-bound section (`2026-10-19`), so the date branch is exercised too |
| `should-pass/0202-url-anchor` | an external version claim is cleared by an http(s) URL |
| `should-pass/0203-non-claim-bullet` | a bullet asserting no API/library fact (a wrap close-out, a status sync) needs no citation and stays silent |
| `should-pass/0204-pre-contract-section` | a claim bullet in a **pre-contract** section (`2026-10-18`) stays silent — the rule describes the current contract instead of reporting history |
| `should-pass/0205-whole-file-anchor` | a path with no `:line` and a backticked root-file name (`AGENTS.md`) are both accepted anchors |
| `should-pass/0206-multiline-citation` | a citation comment split across two lines still clears the bullet |

`0103` and `0102` are the load-bearing fire cases: a "has any citation comment" implementation
passes `0101` but must still fail `0102`, and a "has at least one citation" implementation passes
both while failing `0103`. `0203` and `0204` are load-bearing for the other half — they pin what the
rule deliberately does **not** assert (see Known limits), so widening it is a conscious fixture
change rather than an accident.

## Reproducing one rule by hand

The exit-code evaluator reports ONE finding for a non-zero exit, so the per-bullet reasons are the
script's stdout — read them directly.

```bash
RULE="$(git rev-parse --show-toplevel)/.spur/rules/quality/changelog-claim-citation.yaml"
SRC="$(git rev-parse --show-toplevel)/.spur/rules/fixtures/changelog-claim-citation"

python3 - "$RULE" > /tmp/changelog-claim-citation.sh <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
sys.stdout.write(d["rules"][0]["evaluator"]["config"]["args"][1])
PY

for d in "$SRC"/should-*/*/; do
  TMP="$(mktemp -d)"; cp "$d/CHANGELOG.md" "$TMP/CHANGELOG.md"
  out="$(cd "$TMP" && sh /tmp/changelog-claim-citation.sh 2>&1)"; code=$?
  echo "$(basename "$d") exit=$code ${out:+— $out}"
  rm -rf "$TMP"
done
```

## Known limits

- **Presence-only.** A wrong or decorative citation clears the bullet; which citation proves which
  claim is not deterministically decidable. The marker set is the CLI's closed set, so a claim
  phrased outside it ("the retry helper changed") is not detected.
- **The citation must sit inside the bullet's own block.** A citation in another bullet does not
  clear a neighbouring claim; the rule does not join a bullet to a top-level paragraph.
- **A file carrying no contract-bound section passes.** Sections dated before `2026-10-19` and the
  `## [Unreleased]` heading are the subject; a changelog with only older sections has nothing to
  check. Deleting the sections is therefore not reported here — `0204` pins that boundary
  deliberately.
- **An anchor is not opened.** The rule never checks that the cited path exists or that the line
  holds the claimed behavior; that is the writer's pass (dev-operations §8, step 7) and the
  verification record's job.
