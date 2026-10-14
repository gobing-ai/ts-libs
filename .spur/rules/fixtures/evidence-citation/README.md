# evidence-citation fixtures

Asserts `.spur/rules/quality/evidence-citation.yaml` — the recorded-plane half
of the task-1070 contract ("Source citations for external claims"): a proof-bound
verdict's evidence cell that carries an external API/library claim marker must
also carry a same-cell citation form.

Every case is one staged verdict artifact at `.spur/run/<file>.json`. The rule
scans both verdict planes, so `.spur/memory/evidence/` staging is equivalent and
exercised by the live plane rather than duplicated here.

## should-fire

| Case | Mutation |
|------|----------|
| `0101-verdict.json` | Scoped-package marker (`@typesafe-ai/sdk`), no citation form in the cell. |
| `0102-verdict.json` | Semver markers (`0.4.10`, `0.5.0`) with a prose pointer ("Plan §6") that is not a citation. |
| `0103-verdict.json` | Cell-locality: one cited/marker-free row (R1) does not clear an uncited marker row (R2, `createDriver(opts)` + `node_modules/`). |

## should-pass

| Case | Contract exercised |
|------|--------------------|
| `0201-verdict.json` | Claim cleared by a backticked `path:line` / `path:start-end` citation. |
| `0202-verdict.json` | Claim cleared by a bare (unbackticked) `path:start-end` citation. |
| `0203-verdict.json` | Claim cleared by an http(s) URL. |
| `0204-verdict.json` | Claim cleared by the external named-origin form (`@origin <path> line N`). |
| `0205-verdict.json` | Claim-free receipts (commands, test counts) need no citation. |
| `0206-verdict.json` | Boundary pin: a non-proof-bound artifact (no `proof` key) is not substance-checked, so its uncited marker row passes — historical artifacts describe older contracts. |

Editing any fixture requires updating `scripts/rule-fixture-hashes.json` and the
declared inventory in `scripts/verify-rule-fixtures.ts` together.
