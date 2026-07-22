---
name: spec-driven-artifacts
description: "Artifact-driven engineering workflow (Spec-Kit / HVE style) \u2014 every non-trivial feature flows through persistent, structured markdown documents (spec.md, plan.md, tasks.md, review.md, changes.md) stored in docs/features/<NNN-name>/, so work is traceable, resumable, and reviewable rather than trapped in chat. Use for ANY feature, story, or significant fix: when starting work (\"specify/plan/implement X\"), when resuming partially complete work, or when the user asks for a spec, plan, task breakdown, or review document. The delivery-loop, daedalus, themis, and code-reviewer all write their outputs through these artifacts."
---

# Spec-Driven Artifacts

Chat context evaporates; artifacts persist. Every feature gets a numbered
folder of structured documents that carry the work across sessions, models,
and people. The documents are not paperwork — they are the working state:
the plan constrains the implementation, the tasks track progress, the review
gates completion, and any agent (or human) can resume from them cold.

## Artifact layout

```
docs/features/<NNN>-<kebab-name>/     e.g. docs/features/012-user-search/
├── spec.md        # WHAT & WHY — requirements, written before any code
├── plan.md        # HOW — architecture decisions, constraints, phases
├── tasks.md       # execution state — numbered tasks, updated every iteration
├── review.md      # peer-review findings & resolutions, appended per iteration
└── changes.md     # running log: what changed, when, why (one entry/iteration)
```

`NNN` is the next number in the directory (zero-padded). Never reuse numbers.
Optional extras when warranted: `research.md` (findings from investigating
unknowns before planning), `contracts/` (API schemas), `data-model.md`.

A repo-level `docs/constitution.md` (create from the template on first use)
holds the project's non-negotiable principles — testing requirements,
architecture rules, quality bars. **Every plan.md must include a Constitution
Check section verifying the plan against it; violations require written
justification or a plan change.**

## Templates are mandatory, not suggestions

Full templates live in this skill's `templates/` directory — read the
relevant one BEFORE writing each artifact and follow its structure exactly:

- `templates/spec.md` — user stories with priorities, FR-### functional
  requirements, Given/When/Then acceptance scenarios, edge cases,
  non-functional requirements, out-of-scope
- `templates/plan.md` — technical context, constitution check, architecture
  decisions with rejected alternatives, phase breakdown, risks
- `templates/tasks.md` — T### numbered tasks grouped by phase/story,
  [P] parallelizable markers, per-task file paths and verification
- `templates/review.md` — per-iteration findings ledger with severity,
  evidence, resolution status
- `templates/constitution.md` — project principles

Hard rules that make the artifacts trustworthy:

1. **Mark uncertainty, never invent.** Anything the requester didn't specify
   and you can't verify gets `[NEEDS CLARIFICATION: <question>]` in the
   artifact. A spec with honest clarification markers is complete; a spec
   with guessed requirements is corrupt. Resolve markers with the user before
   implementation reaches them.
2. **Spec is WHAT/WHY only** — no tech stack, no file names, no code in
   spec.md. Plan is where HOW lives. This separation is what lets the spec
   survive an architecture change.
3. **Requirements must be testable.** Each FR-### phrased so a test can pass
   or fail it. "Handle errors gracefully" is not a requirement;
   "FR-007: return HTTP 400 with field-level messages for invalid input" is.
4. **tasks.md is live state.** Mark tasks `[x]` the moment they complete,
   with a one-line outcome. Never batch-update at the end. A stranger reading
   tasks.md mid-work must see exactly where things stand.
5. **Traceability chain**: every task cites the FR/story it serves; every
   review finding cites the task or FR it affects; every changes.md entry
   cites its tasks. Broken chains are findings.

## Workflow phases (gates between them)

**SPECIFY** → write spec.md from the request. Gate: all sections filled or
explicitly N/A; ambiguities marked; requirements testable; user has seen
open clarification markers.

**PLAN** → investigate unknowns first (record in research.md if
substantial), then write plan.md. Gate: constitution check passed or
justified; every architecture decision lists at least one rejected
alternative with the reason; risks named with mitigations.

**TASKS** → decompose the plan into tasks.md. Gate: every FR maps to ≥1
task; every task names its files and its verification; dependency order is
explicit; independent tasks marked [P].

**IMPLEMENT** → execute via the feature-delivery-loop (iterations of
test→code→build→verify→review→document). Each iteration: update tasks.md
checkboxes, append the iteration's review findings to review.md, append one
changes.md entry. The peer-code-review BLOCKER/MAJOR gate applies per
iteration.

**CLOSE** → final review pass over the whole change set; verify the
spec's acceptance scenarios end-to-end; confirm every FR is either
implemented (with evidence) or explicitly descoped (with sign-off);
reconcile all artifacts so they describe what was actually built.

Phases can be run separately across sessions — that is the point. "Resume
012-user-search" means: read its artifacts, find the first unchecked task,
continue.

## Sizing judgment

Full artifact set: features taking more than a day, anything with >5
requirements, anything multiple people/agents will touch. Lightweight
(spec.md + tasks.md only): small well-understood features. Skip artifacts
entirely: one-line fixes — but log notable ones in CHANGELOG per the
delivery loop's documentation rules. When unsure, create the artifacts;
five minutes of structure beats a lost afternoon of archaeology.
