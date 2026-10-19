# decision-boundaries rule fixtures

Non-executed fixtures for the three `decision-boundaries` **import** rules (task 0108, plus the
TypeSafe SDK rule after its subject moved to `@gobing-ai/ts-ai-decision` in ADR-039). Each
directory mirrors the real tree shape (`packages/<pkg>/src/...`) so the rules' `scope.include` globs
match when the rule is evaluated with the fixture directory as the workdir.

- `should-fire/` — each file must produce exactly one finding.
- `should-pass/` — each file must produce zero findings.

These fixtures are **inputs to an automated gate**: `bun run verify-rule-fixtures`
(`scripts/verify-rule-fixtures.ts`) stages every case into a scratch workdir, evaluates it through
the real `RuleEngine` (`verifyRuleFixtures` in `@gobing-ai/ts-rule-engine`), and fails the command on
any mismatch. It runs from `test-post-check`, so `bun run spur-check` covers it and a rule edit can
no longer invalidate a fixture silently.

Only the three import rules are asserted. The package → rule mapping is declared in the adapter
(`packages/ai-runner` → `no-clef-driver-import-in-ai-runner`, `packages/decision-clef` →
`no-ai-decision-import-in-decision-clef`, `packages/decision-fm` →
`no-typesafe-sdk-import-outside-ai-decision`); a fixture under a package with no mapped rule fails
the gate instead of being silently dropped.

## Reproducing one rule by hand

Still useful for a fast answer on a single rule edit. Run from a scratch copy so the rule runner's
SQLite artifacts land outside the repo:

```bash
RULE="$(git rev-parse --show-toplevel)/.spur/rules/typescript/decision-boundaries.yaml"
SRC="$(git rev-parse --show-toplevel)/.spur/rules/fixtures/decision-boundaries"

for expect in should-fire should-pass; do
  TMP="$(mktemp -d)"; cp -R "$SRC/$expect/." "$TMP/"
  for rule in no-clef-driver-import-in-ai-runner no-ai-decision-import-in-decision-clef no-typesafe-sdk-import-outside-ai-decision; do
    n=$(cd "$TMP" && spur rule run --file "$RULE" --rule "$rule" --json | jq '.findings | length')
    echo "$expect  $rule -> $n finding(s)"
  done
  rm -rf "$TMP"
done
```

`should-fire` expects one finding per file, `should-pass` zero.

The manifest-direction rule (`no-clef-dependency-in-ai-runner-manifest`) has no fixture here: its
target is `packages/ai-runner/package.json`, and duplicating that file would give the workspace two
sources of truth. Verify it by temporarily adding `"@gobing-ai/ts-decision-clef": "workspace:*"` to
the real manifest's `dependencies` and re-running the rule — it must report one finding at the
manifest, and report none once the line is removed.
