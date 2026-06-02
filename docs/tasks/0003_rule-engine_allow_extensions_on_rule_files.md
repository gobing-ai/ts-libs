---
name: "rule-engine: allow extensions on rule files"
description: "rule-engine: allow extensions on rule files"
status: Backlog
created_at: 2026-06-02T14:56:32.779Z
updated_at: 2026-06-02T14:56:32.779Z
folder: docs/tasks
type: task
feature-id: ""
priority: medium
impl_progress:
  planning: pending
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

## 0003. "rule-engine: allow extensions on rule files"

### Background

Today only preset files (PresetDefinitionSchema, src/types.ts:241-258) may declare an 'extensions' block; rule files (ConstraintRuleFileSchema, src/types.ts:215-221) cannot. collectPresetExtensions (config/extensions.ts:44) is preset-specific only by naming, not by logic. Discussed in review of 0002: adding extensions to rule files (scope item ①) is low-cost and reuses existing plumbing; per-file capability self-scoping (items ②/③) was rejected as premature — the host-global registry and downward preset composition via extends stay as-is. The existing allowExtensions trust gate (extensions.ts:77-82) must remain unchanged: rule-file extensions get NO weaker trust treatment than preset extensions.


### Requirements

1. ConstraintRuleFileSchema accepts an optional 'extensions' block with the same shape and relative-path/no-traversal validation as presets (resolvers/evaluators/fixers/formatters). 2. Single-rule schema (ConstraintRuleSchema) does NOT gain extensions. 3. loadRuleFile threads collected extension refs out (currently returns extensions:[] — loader.ts:146,154 path). 4. Generalize collectPresetExtensions → collectExtensions(sourceName, dir, extensions); both preset and rule-file paths call it. 5. Both ConstraintRuleFileSchema and PresetDefinitionSchema extensions sub-objects are .strict() so a misplaced/typo'd key errors loudly instead of silent-ignore. 6. allowExtensions gate unchanged; capability registry stays host-global; no per-file scoping. 7. Tests cover: rule-file extension load, traversal rejection on rule files, strict-mode key rejection, and that allowExtensions:false still throws for rule-file extensions.


### Q&A



### Design



### Solution



### Plan



### Review



### Testing



### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References


