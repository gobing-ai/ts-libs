# decision-boundaries rule fixtures

Non-executed fixtures for the three `decision-boundaries` rules added by task 0108. Each directory mirrors the real
tree shape (`packages/<pkg>/src/...`) so the rules' `scope.include` globs match when the rule is
evaluated with the fixture directory as the workdir.

- `should-fire/` — each file must produce exactly one finding.
- `should-pass/` — each file must produce zero findings.

These fixtures are **not** part of any automated gate: they live under `.spur/`, outside the
`packages/**` scopes the rules scan, so `bun run spur-check` never sees them. They exist so a rule
edit can be re-verified by hand.

## Reproducing the check

Run from a scratch copy, so the rule runner's SQLite artifacts land outside the repo:

```bash
RULE="$(git rev-parse --show-toplevel)/.spur/rules/typescript/decision-boundaries.yaml"
SRC="$(git rev-parse --show-toplevel)/.spur/rules/fixtures/decision-boundaries"
TMP="$(mktemp -d)"

cp -R "$SRC/should-fire/." "$TMP/"
# The manifest-direction rule is excluded: its target is a package.json, not a source file,
# so its positive control is a temporary edit of the real manifest (see below).
for rule in \
  no-clef-driver-import-in-ai-runner \
  no-ai-decision-import-in-decision-clef
do
  n=$(cd "$TMP" && spur rule run --file "$RULE" --rule "$rule" --json | jq '.findings | length')
  echo "should-fire  $rule -> $n finding(s)  (expected 1)"
done

rm -rf "$TMP"; TMP="$(mktemp -d)"
cp -R "$SRC/should-pass/." "$TMP/"
for rule in no-clef-driver-import-in-ai-runner no-ai-decision-import-in-decision-clef
do
  n=$(cd "$TMP" && spur rule run --file "$RULE" --rule "$rule" --json | jq '.findings | length')
  echo "should-pass  $rule -> $n finding(s)  (expected 0)"
done
rm -rf "$TMP"
```

The manifest-direction rule (`no-clef-dependency-in-ai-runner-manifest`) has no fixture here: its
target is `packages/ai-runner/package.json`, and duplicating that file would give the workspace two
sources of truth. Verify it by temporarily adding `"@gobing-ai/ts-decision-clef": "workspace:*"` to
the real manifest's `dependencies` and re-running the rule — it must report one finding at the
manifest, and report none once the line is removed.
