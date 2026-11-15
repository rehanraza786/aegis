# MERGE THIS INTO YOUR .github/copilot-instructions.md
# (Don't overwrite your existing file, append this section.)
# Custom instructions are sent with EVERY request, so this section is kept
# short on purpose: detail lives in the skills, which load only when needed.

## Codebase knowledge base

For any coding task, read `docs/generated/agent-context.md` first (~60 lines).
Then go cheapest first: generated docs → graph tools (`context_pack`,
`find_symbol`, `blast_radius`, `message_flow`, `db_map`, `http_map`) →
`.github/knowledge/` for module intent → source files, only to edit or when the
layers above point somewhere specific. If the knowledge base is missing or
stale, suggest the pythia agent.

Skills (use them instead of improvising a tool order):
- **codebase-orientation**: unfamiliar code or module.
- **change-impact-analysis**: BEFORE modifying anything shared.
- **flow-tracing**: follow a request/event end to end, or "X happened but Y never did".
- **safe-schema-change**: any table, column, view, stored procedure, entity, or migration.
- **event-contract-change**: publishing, consuming, or altering any event.
- **graph-augmentation**: the graph reports a gap you can resolve with evidence.
- **aegis-help**: which tool answers this, or the toolkit misbehaves.

Standing rules: topic names come from config or constants, never literals. Every
schema change (tables, views, procs) goes through the repo's migration layer
and is verified with `db_map` (no DRIFT = done). Check `decisions` before
contradicting an architectural choice. Prefer scoped queries (`db_map table:X`)
over unscoped ones, and never read a generated doc marked "do not read whole".
Never `assert_edge` from naming alone or just to silence a warning.

For long work, suggest an agent: @daedalus build, @asclepius debug, @hephaestus
refactor, @argus review, @metis design + ADR, @themis spec audit, @hermes document.
