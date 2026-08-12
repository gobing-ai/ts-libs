---
name: Project Constitution
doc: 99_PROJECT_CONSTITUTION
owns: PROCESS — how the key files are maintained
authority: authoritative-on-process
version: 1.3.0
created_at: 2026-08-12
updated_at: 2026-08-12
edit_rules: 99 §6.8
sync: [T7]
read_before: editing any numbered doc above
---

# Project Constitution — How to Organize the Project

## 1. What this is & what this is not

This is the **constitution** for the project's key files: an accumulated, machine-maintained set
of rules and lessons for running the same file structure across different projects and
cooperating with multiple coding agents (Claude Code, Codex, Gemini CLI, pi, omp, Antigravity,
OpenCode, OpenClaw, Hermes, Grok, ...).

- One copy lives in every project at `docs/99_PROJECT_CONSTITUTION.md`.
- It is **byte-identical across projects** except the Lessons sections (§8) and the tool-binding
  column (§3). When it improves in one project, propagate to the others — forks are drift.
- It contains **zero project-specific facts** — no project command names, package names, feature
  states, or decisions. Project facts live in the numbered docs this file governs. If you find a
  project fact here, that itself is drift: move it to its owning doc.

This is **not** a project review summary, a technical review list, or a product-design
reflection.

Audience: humans and coding agents equally. Every rule below is written to be checkable — an
agent should be able to verify compliance mechanically, not interpret intent.

## 2. Authority model

Two axes that cannot collide:

| Axis | Question | Winner |
|------|----------|--------|
| **Content** | What is true about the project? | Lower number wins: `00_ADR` is binding on *decisions*; `01_PRD` is authoritative on *scope*; `02`–`05` are derived |
| **Process** | How are the key files maintained? | **This file** |

They cannot conflict because this file holds no project content (§1 rule 3).

**Why this file is numbered 99, not 00:** "lower number wins" is a *content* rule, and this file
plays on the other axis. The out-of-band number is the visible signal that the constitution sits
outside the content chain — renumbering it into the chain (e.g. as `00`) would re-entangle the
two axes and force a renumber of every content doc, invalidating the dense web of cross-pointers
(`03 §12`-style references baked into append-only ADR text) for a purely aesthetic gain. Do not
renumber.

**Content conflict rule:** when two docs disagree, fix the **authoritative** doc first (with a
dated amendment if it is append-only), then the derived doc, then `AGENTS.md` — and flag the
drift in the commit message or task. Never average two conflicting statements into a third.

## 3. Shared tools

Tools are bound by **role**; roles are permanent, bindings evolve. This table is the only
project-variable section besides Lessons — update the binding when the toolchain migrates.

| Role | Current binding | Notes |
|------|-----------------|-------|
| Spec lifecycle — tasks | `spur task` | Task files are tool-owned; edit through the tool, never the Write tool |
| Spec lifecycle — features | `spur feature` | Same tool-owned rule |
| Delivery harness | `spur`; canonical gate: `bun run spur-check` | Quality gates are self-hosted through it where possible |
| Agent-facing wrappers | installed `sp-*` skills and `/sp-dev-*` command wrappers | **Fat Skills, thin others:** skills are the SSOT for agent-facing behavior and may be arbitrarily rich; slash commands and subagents are thin wrappers of skills (every agent supports skills; command/subagent support varies) |

## 4. Common file layout

### 4.1 The doc map (canonical template)

Each project's `AGENTS.md` embeds an instantiated copy of this table (§4.4). A fact lives in
**one** doc; other docs link to it, never restate it.

| Doc | Owns the question | Authority | Read / edit when |
|-----|-------------------|-----------|------------------|
| `docs/00_ADR.md` | **WHY** — which cross-cutting decision was made, and the one-line reason | **Authoritative** (wins all content) | Read before any structural change; add a dated entry before diverging from a decision |
| `docs/01_PRD.md` | **WHAT** — product vision, users, scope (in / out / deferred) | **Authoritative on scope** | Read before adding a command/feature; edit when scope changes |
| `docs/02_ROADMAP.md` | **WHEN** — phases, current vs deferred, sequencing | Derived | Read to place work in a phase; edit when phase status changes |
| `docs/03_ARCHITECTURE.md` | **HOW** — module boundaries, data flow, runtime model, invariants, rationale-in-depth | Derived (ADR wins) | Read before cross-module/seam/schema work; edit when boundaries or mechanisms change |
| `docs/04_DESIGN.md` | **SURFACE** — concrete shapes: every CLI command, flag, config key, env var, table, DTO; **index over `docs/design/<slug>.md`** (§4.5) | Derived | Read/edit when changing a non-UI command, flag, env var, or schema — same commit |
| `DESIGN.md` (repo root) | **UI/UX SURFACE** — visual design, color tokens, typography, component specs, layout, micro-animations, accessibility | **Authoritative for UI/UX when present** | Read/edit when planning or implementing UI/UX visual changes (dynamically supported; ignored when absent) |
| `docs/05_FEATURES.md` | **STATUS** — feature decomposition + state (✅ done / 🔶 partial / ⏳ planned / 💤 deferred); **index over `docs/features/<id>_<slug>.md`** (§4.5) | Derived | Read to find a feature's state; edit when a feature's status changes |
| `docs/99_PROJECT_CONSTITUTION.md` | **PROCESS** — how the files above are maintained | **Authoritative on process** | Read before editing any doc above; edit per §6.8 |
| `AGENTS.md` (repo root) | **ENTRY** — how agents work in this repo: stack, commands, gates, conventions + the instantiated doc map | Derived (from 99 + 00/01/04) | Read first every session; regenerate factual blocks from code (§6.7) |

**Routing — put each fact in its owning doc, link from the rest:**

- Decision + one-line reason → `00`. Rationale/mechanism in depth → `03`.
- Scope (in/out/deferred) → `01`. Mechanism / data flow / invariants → `03`.
- UI/UX visual design, design tokens, component specs & accessibility → `DESIGN.md` (when present; otherwise follow established project UI conventions).
- Non-UI command/flag/config/schema/DTO shapes → `04`. Phase timing → `02`. Feature status → `05`.
- If you are writing *how it's built* or *why* inside `00`/`01`/`02`, it belongs in `03`/`04`.

### 4.2 Working layers (outside the authority chain)

| Location | Purpose | Rules |
|----------|---------|-------|
| `docs/plans/YYYY-MM-DD-<topic>.md` | Dated working documents: research, triage, design discussions, decision records-in-progress | They **record**, they do not **govern**. Once concluded, immutable except dated correction sections. Decisions they reach must be promoted into `00`–`05` to take effect |
| `docs/tasks/` | Task files | Tool-owned (§3). Never edited with raw file writes |
| other `docs/` folders | Optional scratch (analysis, refactor notes, ...) | Nothing in the authority chain may depend on them |

`docs/design/` and `docs/features/` are **not** scratch — they are the satellite layers of `04` and
`05` and are governed by §4.5.

### 4.3 Standard frontmatter (the doc's machine-readable contract)

Every numbered doc (`00`–`05`, and `99` itself) opens with YAML frontmatter carrying its doc-map
row plus bookkeeping — so an agent learns the doc's contract from the file head without loading
the doc map, and tooling can validate it:

```yaml
---
doc: 03_ARCHITECTURE
owns: HOW — module boundaries, data flow, runtime model, invariants
authority: derived            # authoritative | authoritative-on-scope | authoritative-on-process | derived
version: 1.1.0
derived_from: [00_ADR, 01_PRD]   # omit for 00
owner: <name>
updated_at: YYYY-MM-DD
read_before: cross-module, seam, or schema work
edit_rules: 99 §6.4
sync: [T1]                    # §5 trigger IDs that obligate touching this doc
---
```

Rules:

1. The frontmatter **is** the instantiated copy of this file's §4.1 row — `owns`/`authority`
   must match it verbatim in meaning; the §7 audit checks this. On mismatch, §4.1 wins.
2. `edit_rules` points to the owning §6 subsection — rules are never restated in frontmatter
   (pointers over prose, §6.0).
3. Bump `version` (minor) on any substantive edit; always refresh `updated_at` in the same edit.
   A doc whose `updated_at` predates a change it should reflect is drift — repair per §7.
4. Frontmatter replaces the legacy bold header block (`**Version:** …` lines); a doc carrying
   both is drift.
5. Doc **bodies do not restate** their own authority or the conflict rule ("when this conflicts
   with the ADR, the ADR wins") — frontmatter `authority` and §2 own that. Preamble
   restatements are drift.

### 4.4 AGENTS.md synchronization

- `AGENTS.md` is the **per-project instantiation**: the §4.1 table (instantiated), plus
  project-specific stack, commands, verification gates, and conventions.
- This file is the canonical template; when §4.1 or §5 changes here, re-sync `AGENTS.md` in the
  same change.
- `AGENTS.md` may **add** project facts; it may never **contradict** the numbered docs. On
  contradiction, the numbered doc wins — fix `AGENTS.md`.

### 4.5 Index + satellite docs (`04`/`05` and their folders)

Two derived docs are **index pages** over a folder of per-item **satellite** files. The index holds
the headline rows + pointers; each satellite holds one item's detail. This keeps the index readable
(loaded every session) while detail scales without bloating it.

| Index doc | Satellite folder | Satellite file name | Satellite ownership |
|-----------|------------------|---------------------|---------------------|
| `docs/04_DESIGN.md` | `docs/design/` | `docs/design/<slug>.md` | Hand-maintained derived doc (§6.5) |
| `docs/05_FEATURES.md` | `docs/features/` | `docs/features/<feature-id>_<slug>.md` | **Tool-owned** (§3 — `spur feature`/`ftree`); satellites *and* the index region are written by the tool, never by raw file writes |

Rules (both axes):

1. **The index is the single entry point.** A reader starts at `04`/`05`; every satellite is
   reachable from exactly one index row. A satellite with no index row, or an index row with no
   satellite, is drift (§7 audit).
2. **One item per satellite.** `<slug>` (design) / `<feature-id>_<slug>` (features) is the grep
   anchor (§6.0 rule 6) — stable once chosen; renaming is a rename of the file *and* its index row in
   the same change.
3. **Detail lives only in the satellite; the index carries pointer + status only.** The index never
   restates a satellite's body (§6.0 rule 2). For `05`, a row is `<id> <status> <name> → pointer`;
   for `04`, an index row names the surface area and points at its `docs/design/<slug>.md`.
4. **The index is regenerable for `05`** (tool-written) and **hand-curated for `04`** — but in both
   cases the satellite is the source of truth and the index is derived from it. Never edit `05`'s
   generated index region by hand; never let a `04` index row diverge from its satellite.
5. **Edit order is fixed (§5 T9): detail first, then index.** Write/update the satellite, then update
   the index row — in the **same change**. Updating the index before the detail exists creates a
   pointer to nothing; the reverse leaves the detail unindexed. For tool-owned features, "update the
   index" is running the tool's refresh (e.g. `spur feature refresh`), not a manual edit.

## 5. Sync triggers — same-commit obligations

The root cause of stale key files is *unsynchronized success*: code ships, docs don't hear about
it. Each trigger below has a stable ID (referenced by doc frontmatter `sync:` lists, §4.3) and
names the docs that must be touched **in the same commit / same change**:

| ID | When this happens | Touch (same change) |
|----|-------------------|---------------------|
| T1 | New cross-cutting decision, or reversal of one | `00` **first** (dated entry), then `03` mechanism, `01` if scope shifts |
| T2 | A code change would contradict an existing ADR | **Stop.** Add the superseding/amending ADR entry first — never silently diverge |
| T3 | Command, flag, config key, env var, schema, or DTO added/changed | `04` + the `AGENTS.md` surface block |
| T4 | A feature ships or changes state | its `05` row; a new `01` scope row if it is new surface |
| T5 | A phase completes, reorders, or gains items | `02` (update the bullet to the *real, shipped name* of the deliverable) |
| T6 | Scope added / cut / deferred | `01`; placement in `02` |
| T7 | The doc map or process changes | this file → re-sync `AGENTS.md` (§4.4) → propagate to sibling projects |
| T8 | A multi-wave batch is planned | schedule "doc sync" as an **explicit work item** — same-commit discipline does not survive on memory alone |
| T9 | A design or feature item is added/changed | the satellite **first** (`docs/design/<slug>.md` or `docs/features/<id>_<slug>.md`), **then** its index row in `04`/`05` — same change (§4.5 rule 5) |

## 6. Edit principles per file

### 6.0 Writing rules (all key files)

Token economy is a design goal: these files are read by LLM agents at session start, every
session, across every project — a redundant sentence is paid for thousands of times. Precise
**and** concise; precision wins when they conflict.

1. Declarative, information-dense sentences. No filler, no marketing adjectives, no hedging, no
   narrative buildup.
2. A fact lives once — link or point (`see 03 §12`) instead of restating, both in-file and
   cross-file. Restatement is the largest token sink in a doc system, bigger than any tone rule.
3. Tables for enumerable facts; prose only where reasoning is needed.
4. Front-load: rule first, elaboration after — readers (human or agent) may only take the head.
5. Define a term once, then reuse it verbatim. Synonyms read as new concepts to a machine.
6. Headings and IDs (`ADR-NNN`, `T1`–`T8`, `§6.x`, feature rows) are grep targets and
   cross-reference anchors — never rename casually.
7. **Concise never beats correct.** If brevity creates ambiguity, add the missing words: tokens
   saved in reading are lost many times over in a misexecuted run.

These rules are stated once, here. Per-file sections below and doc frontmatter inherit them via
pointer — restating them per file would violate rule 2.

### 6.1 `docs/00_ADR.md`

Entry template:

```markdown
## ADR-NNN: <Decision title, outcome-shaped>

**Status:** Accepted | Accepted (design) | Superseded by ADR-MMM | Skipped · **Date:** YYYY-MM-DD

**Decision.** <What was decided — the smallest complete statement of the choice.>

**Why.** <One line. The single strongest reason.>

**Detail:** <pointer into 03/04/plans — depth never lives here.>
```

1. **One decision per entry.** If a draft contains a principle *and* a deferred design *and* a
   mechanism choice *and* implementation tips — split it: decision(s) here, mechanism in `03`,
   shapes in `04`, tips nowhere (they are implementation guidance, not decisions).
2. **ADR = decision + one-line reason.** No Zod patterns, no lock details, no code idioms.
3. **Append-only.** Never renumber, never delete, never rewrite history. Corrections are dated
   `**Amendment (YYYY-MM-DD)**` blocks inside the entry; reversals are **new entries** that name
   what they supersede, while the old entry's Status becomes `Superseded by ADR-MMM`.
4. **Numbering:** next free integer, one sequence per repo. A burned/skipped number gets a stub
   entry (`Status: Skipped`) so the gap is audit-clean and never reused.
5. **`Accepted (design)`** means decided but not built — readers must be able to tell decided
   from shipped.
6. **Before any code that contradicts an ADR:** the superseding entry lands first (§5 row 2).
7. **Retrofit rule:** the entry template binds **new entries and amendments only**. Historical
   entries are never restructured to match it — append-only beats stylistic consistency. The
   non-entry preamble is normal editable text.
8. **Amendments record the decision delta.** An `**Amendment**` block records *what changed about the
   decision* — the new choice and its one-line reason — plus a `Detail:` pointer for mechanism.
   Implementation file paths, detailed semantics, and multi-paragraph rationale belong in `03`/`04`,
   not in the amendment body. If an amendment would carry more than a few lines of non-decision text,
   the mechanism has leaked in; link it instead of inlining it.

### 6.2 `docs/01_PRD.md`

1. Owns vision, users, principles, scope. **No mechanism** (→ `03`), **no timing** (→ `02`),
   **no shapes** (→ `04`).
2. **Every shipped surface has a scope row.** When a command/capability ships, its row enters
   the in-scope table in the same change — shipped-but-unlisted is the most common drift.
3. Scope states are explicit: *in (committed)* / *supporting* / *deferred (needs design
   reconfirmation)* / *out of scope*. A deferred item carries the condition that would
   reactivate it.
4. Surface beyond the committed set is **not ported/built speculatively** — re-confirm the need
   first and record the evidence pointer (a dated plans doc, usage data) in the entry that
   admits it.
5. **Scope tables carry membership only** — no delivery-status columns (`05` owns status; a
   status column in `01` is a guaranteed drift magnet). Likewise, quantitative gate values
   (coverage thresholds, etc.) live with their enforcement config — point to the gate, never
   restate the numbers.

### 6.3 `docs/02_ROADMAP.md`

1. Derived: it may **sequence** facts from `00`/`01`/`05` but never introduce new ones.
2. Every phase has a goal sentence, checkbox items, and an explicit **Exit:** criterion.
3. Markers: `[x]` done · `[~]` partial · `[ ]` pending. `[x]`/`[~]` carry a one-line evidence
   note (what shipped, where).
4. When a deliverable lands under a different name than planned, rewrite the bullet to the real
   name — a roadmap that tracks dead names reads as undelivered work.
5. Phases gate on the previous one. Insert sub-phases (`1.5`) rather than renumbering existing
   ones.

### 6.4 `docs/03_ARCHITECTURE.md`

1. Describes the **current** architecture. Future/accepted designs are allowed only in sections
   explicitly titled `(accepted design — ADR-NNN; not yet built)`.
2. Owns module boundaries, data flow, runtime model, invariants, and rationale-in-depth. Not
   schemas/signatures (code and `04`), not decisions (`00`).
3. Write invariants as **enforceable statements** — phrased so a constraint rule or a reviewer
   can check them mechanically.
4. When a migration replaces a mechanism (parser, dispatcher, bootstrap), update the module
   descriptions in the same change — stale module lists survive multiple releases unnoticed.
5. On conflict with `00`: the ADR wins; fix here and flag.

### 6.5 `docs/04_DESIGN.md` + `docs/design/<slug>.md`

`04` is the **index page** over the `docs/design/` satellites (§4.5). The index carries the surface
map + pointers; each `docs/design/<slug>.md` holds one surface area's detailed design.

1. **Same-commit rule:** any change to a command, flag, config key, env var, table, or DTO
   updates `04` (and its satellite) in that commit (§5 T3/T9). In batch planning, doc sync is an
   explicit scheduled item.
2. **Detail-first edit order (§4.5 rule 5 / T9):** write or update the `docs/design/<slug>.md`
   satellite first, then update its `04` index row — never the reverse. A new surface area gets a
   new satellite + a new index row in the same change.
3. Prefer **generated** artifacts over hand-maintained ones (e.g. OpenAPI from the contract);
   never hand-write what can be derived — and never let a derivable artifact be edited by hand.
4. Shapes only. Rationale lives in `00`/`03`. **Behavioral notes are shapes** ("resolving zero
   rules exits 1" — keep); justifications are not ("...because a silent gate is the worst
   failure mode" — cut, or point to `00`/`03`). This applies to satellites too — they hold
   *detailed shapes*, not rationale.
5. Command signatures are **transcribed from the code registrations**, never from memory or from
   an older doc revision — a signature is a factual block in the §6.7 sense.
6. The index never restates a satellite's body (§6.0 rule 2): an `04` row names the surface area,
   its status, and points at `docs/design/<slug>.md`. `<slug>` is a stable grep anchor (§6.0 rule 6).

### 6.6 `docs/05_FEATURES.md` + `docs/features/<feature-id>_<slug>.md`

`05` is the **index page** over the `docs/features/` satellites (§4.5). Both the satellites and `05`'s
generated index region are **tool-owned** (§3 — `spur feature`/`ftree`): edit through the tool, never
with raw file writes.

1. One index row per deliverable, each with a concrete **acceptance** check, status from the legend
   (✅ done · 🔶 partial · ⏳ planned · 💤 deferred), and a pointer to its
   `docs/features/<feature-id>_<slug>.md` satellite.
2. The satellite + its index row change in the **same change** that ships or re-scopes the feature
   (§5 T4/T9).
3. **Detail-first edit order (§4.5 rule 5 / T9):** update the feature satellite first (via the tool),
   then refresh the index (e.g. `spur feature refresh`) — never hand-edit the generated index region,
   and never update the index ahead of the detail.
4. **Never trust a row you have not verified.** Before citing or building on a status, check it
   against code — status rows rot silently in both directions (done-but-⏳ and ⏳-but-claimed).
5. `05` keeps headline rows + pointers; the full decomposition lives in the satellite files.
   `<feature-id>` is the stable grep anchor (§6.0 rule 6); renaming is a tool operation, not a raw
   edit.

### 6.7 `AGENTS.md`

1. Factual blocks that mirror code — the command surface, the workspace layout, tool versions —
   are **regenerated from code**, never edited from memory. Verify with the actual registrations
   (e.g. list the CLI's registered nouns/verbs) before writing the block.
2. Keep it lean: link to the owning doc instead of restating its facts. `AGENTS.md` repeats only
   what an agent needs in the first 30 seconds of a session.
3. Surfaces that are decided-but-unbuilt are flagged as planned with their ADR pointer, and
   marked "do not invoke as if they exist".
4. Re-synced whenever this file changes the map or process (§4.4).

### 6.8 This file (`99`)

1. **No project facts** — ever (§1). Tool bindings (§3) and Lessons (§8) are the only
   project-variable content.
2. Structure and principles change only on operator request; Lessons sections are
   machine-appendable per the §8 protocol without asking.
3. When this file improves in one project, **propagate the improvement to sibling projects** —
   it is one constitution with N copies, not N constitutions.

## 7. Drift control

**Drift** = reality (code, shipped behavior) disagreeing with what a key file says, or two key
files disagreeing with each other.

**Repair protocol** (always this order):

1. Fix the **authoritative** doc — for append-only files, by dated amendment, never rewriting.
2. Then the derived docs that restate or sequence it.
3. Then `AGENTS.md`.
4. Flag what drifted and why in the commit message / task — a silent fix hides the systemic
   cause.

**Audit cadence:** at every phase exit, and before designing any large batch, run the drift
audit:

- [ ] List the real CLI/tool surface from code; diff against `AGENTS.md`'s surface block and
      `00`'s committed-surface entries.
- [ ] For every `05` row marked ✅/🔶, spot-check the acceptance against code; for every ⏳, check
      it didn't quietly ship.
- [ ] For every shipped surface, confirm a `01` scope row exists.
- [ ] Check `02`'s current phase bullets name things that actually exist (no dead names).
- [ ] Check `03`'s module descriptions against the real file tree of each app/package.
- [ ] Confirm `04` covers every command/flag/config/schema that exists.
- [ ] For `04`/`05` (§4.5): every index row points to an existing satellite, and every satellite
      (`docs/design/<slug>.md`, `docs/features/<id>_<slug>.md`) has exactly one index row — no orphan
      satellites, no dangling pointers.
- [ ] Confirm `AGENTS.md`'s doc map matches §4.1 of this file.
- [ ] Confirm each doc's frontmatter matches its §4.1 row and its `updated_at` is plausible
      against recent commits (§4.3).

Findings are repaired via the protocol above, and anything systemic becomes a Lesson (§8) — or,
if it recurs, a new rule in §6.

## 8. Lessons learned per file

**Append protocol (machine-maintained):**

- Format: `- [YYYY-MM-DD] <project>: <lesson — what went wrong / what to do instead>`
- Threshold is **low** — when in doubt, append. Check for an existing equivalent first; bump its
  date instead of duplicating.
- **Promotion rule:** a lesson that recurs or hardens into practice is promoted into a §6 rule
  (or a §5 trigger) and removed from this section. Lessons are the inbox; §5/§6 are the law.
  Promotion is the only sanctioned deletion.
- Lessons carry project provenance because this file is copied across projects — a lesson from
  one project is a warning, not yet a law, for the others.

### Lessons for `docs/00_ADR.md`

_(empty — add lessons as the project evolves)_

### Lessons for `docs/01_PRD.md`

_(empty — add lessons as the project evolves)_

### Lessons for `docs/02_ROADMAP.md`

_(empty — add lessons as the project evolves)_

### Lessons for `docs/03_ARCHITECTURE.md`

_(empty — add lessons as the project evolves)_

### Lessons for `docs/04_DESIGN.md`

_(empty — add lessons as the project evolves)_

### Lessons for `docs/05_FEATURES.md`

_(empty — add lessons as the project evolves)_

### Lessons for `AGENTS.md`

_(empty — add lessons as the project evolves)_

### Lessons for this file (`99`)

_(empty — add lessons as the project evolves)_

## 9. Bootstrapping a new project

Checklist to instantiate this structure in a fresh repo:

1. Copy this file verbatim to `docs/99_PROJECT_CONSTITUTION.md`; empty the §8 lessons of
   other projects' entries or keep them as inherited warnings (recommended: keep).
2. Update §3 bindings if the new project's toolchain differs.
3. Create `docs/00_ADR.md` with the §4.3 frontmatter and `ADR-001` recording the founding
   decision (stack, structure, the why).
4. Create `docs/01_PRD.md`: vision paragraph, users, principles table, scope tables (in /
   supporting / deferred / out).
5. Create `docs/02_ROADMAP.md` with Phase 0 and its exit criterion.
6. Create `docs/03_ARCHITECTURE.md`: topology, dependency boundary, runtime model — current
   state only.
7. Create `docs/04_DESIGN.md` (may start near-empty) and `docs/05_FEATURES.md` (legend + first
   rows).
8. Create root `AGENTS.md`: instantiated §4.1 doc map, stack/layout, commands, verification
   gate, conventions. Symlink `CLAUDE.md` (and equivalents) to it.
9. Wire the §3 tools (spec lifecycle, harness) per their own docs.
10. First-session rule for any agent: read `AGENTS.md` → this file → `00`/`01` before touching
    anything.
