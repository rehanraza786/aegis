# MERGE THIS INTO YOUR .github/copilot-instructions.md
# (Don't overwrite your existing file, append this section.)
# Custom instructions are always-on, so this one pointer makes every
# Copilot task KB-aware without loading the full skill each time.

## Codebase knowledge base

Read `docs/generated/agent-context.md` FIRST for any coding task, it orients you in ~100 lines (modules, topics, tables, high-risk files, lookup order). This repo also has a knowledge map at `.github/knowledge/`. Before exploring
source files for any task, read `.github/knowledge/INDEX.md` and the relevant
`modules/<module>.md` file, they answer most "where is X / how does Y work"
questions in a few hundred tokens. Open source files only to edit them or when
the knowledge base points you to a specific location. Check
`.github/knowledge/graph.md` for blast radius before changing shared modules.
After changing a module's public surface or dependencies, update its knowledge
file (see the codebase-orientation skill for the format). If the knowledge base
is missing or stale, suggest running the pythia agent.

## Which AEGIS skill to use

These skills encode the right sequence of graph tool calls. Reach for them
instead of improvising a tool order:

- **codebase-orientation**: new to this code, or starting work in an unfamiliar
  module. "How does this system work?"
- **change-impact-analysis**: BEFORE modifying anything shared. "What breaks if
  I change X?" Covers code, Kafka, DB, HTTP, and standing decisions in one pass.
- **flow-tracing**: follow a request or event end to end; or debug "X happened
  but Y never did".
- **safe-schema-change**: any new table, column, entity, or migration. Liquibase
  first, always; verify with `db_map` afterwards (no DRIFT = done).
- **event-contract-change**: publishing, consuming, or altering a Kafka event.
  Never hardcode a topic literal; verify producer and consumer correlate with
  `message_flow` afterwards.
- **aegis-help**: which tool answers this question, or the toolkit itself is
  misbehaving.

Standing rules for this repo: topic names come from config or constants, never
literals. Every schema change goes through a Liquibase changeset. Check
`decisions` before contradicting an architectural choice, a design that looks
wrong is often one that was made deliberately and recorded.

## Which AEGIS agent to hand off to

- **@daedalus**: build a feature end to end (adds behavior).
- **@asclepius**: something is broken; diagnose it before changing anything.
- **@hephaestus**: rename, extract, migrate, or deprecate at scale (preserves
  behavior exactly; never leaves the codebase half-migrated).
- **@argus**: review a diff or branch before merge.
- **@metis**: a design choice with real trade-offs; weighs options against this
  codebase, then records the ADR.
- **@themis**: does the code actually satisfy the spec?
- **@hermes**: document a flow. **@pythia**, refresh the knowledge base.

## Large codebases

Prefer scoped queries (`db_map table:X`, `message_flow topic:Y`) over unscoped
ones. Unscoped correlation tools return a summary, counts, the full warning
lists, the busiest items, not an exhaustive dump; that is deliberate. Do not
read a generated document that carries a "do not read whole" banner into
context; query the tool for the item you need. Tool results are row- and
byte-capped, and warnings are never dropped by truncation.

## When the graph is wrong or blind

Static analysis cannot evaluate code, so runtime-assembled topics, tables, and
routes show up as gaps rather than facts. Call `graph_gaps` to see them. If you
can work out the answer by reading the code (following a constant, a config key,
a Spring profile), record it with `assert_edge`, with evidence you would defend
in review. It lands in `docs/graph-assertions.json` (committed, reviewable) and
enters the graph tagged `[ASSERTED]`, never mixed with parsed facts. Never assert
from naming alone, and never assert just to silence a warning: an orphan topic is
often a real bug.
