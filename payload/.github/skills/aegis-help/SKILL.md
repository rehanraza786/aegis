---
name: aegis-help
description: Work out which AEGIS capability answers the question at hand, and fix AEGIS itself when it misbehaves. Use when the user asks what this toolkit can do, which tool or agent to use, "how do I ask for X", or when the graph tools are missing, returning stale answers, erroring, or reporting no data. Also use when an answer from the graph looks wrong, so it can be diagnosed rather than trusted or discarded.
---

# AEGIS Help

Two jobs: route the question to the right capability, and repair the toolkit when
it's the thing that's broken.

## Routing: question → capability

Always prefer the cheapest thing that answers the question. The ladder is
`agent-context.md` → generated docs → graph tools → knowledge base → source files.

| The question | Reach for |
| --- | --- |
| Where is X? | `search_code`, `find_symbol` |
| What's in this file? | `file_outline` (do not read the file) |
| What calls this? | `find_callers`, then `find_references` to be certain |
| What breaks if I change this? | the **change-impact-analysis** skill |
| I'm new here / how does this work? | the **codebase-orientation** skill |
| Follow this request/event end to end | the **flow-tracing** skill |
| Why isn't X arriving in Y? | the **flow-tracing** skill (debug mode) |
| Who produces/consumes this topic? | `message_flow` |
| What touches this table? | `db_map` |
| Which frontend calls this endpoint? | `http_map` |
| I need a new column / table | the **safe-schema-change** skill |
| I need to publish / consume an event | the **event-contract-change** skill |
| What is this module for? | `explain` |
| Why is it built this way? Still valid? | `decisions`, `decision_trace` |
| We just decided something | `save_decision` |
| The graph is missing something / a topic won't resolve | `graph_gaps`, then the **graph-augmentation** skill |
| Build a whole feature | `@daedalus`, or the **feature-delivery-loop** skill |
| Review this code | `@argus`, or the **peer-code-review** skill |
| Something is broken and I don't know why | `@asclepius` — reproduce, hypothesize, disprove, fix |
| Rename/extract/migrate across the codebase | `@hephaestus` — behavior-preserving, never half-done |
| Which design should we choose? | `@metis` — weighs options, then records the ADR |
| Does the code match the spec? | `@themis`, or the **spec-gap-analysis** skill |
| Document this flow | `@hermes` |
| How much of the project is done? | `docs/generated/PROGRESS.md` |

Two things worth knowing without being asked:

- **`find_callers` is a heuristic; `find_references` is compiler-grade.** Use the
  first to explore, the second before making any claim that something is or isn't
  used anywhere.
- **Orphan and drift warnings are findings, not noise.** "Produced but no
  consumer", "accessed but no changeset defines it" — surface these when you see
  them, even if nobody asked.

## Working on a large codebase

On a big system the tools protect your context automatically, but you should
know how, so the output doesn't surprise you.

- **Calling `message_flow`, `db_map`, or `http_map` with no argument returns a
  summary, not a dump** — counts, the complete warning lists (orphans, drift),
  and the busiest items, with a pointer to query one item at a time. This is the
  right default: on a system with 400 topics, the full listing is useless *and*
  would consume most of your context. The warnings are the signal.
- **Always scope the query when you can.** `db_map table:payments` beats reading
  a 900-table map and hunting.
- **Do not read the generated documents into context** when they carry the
  "describes N items — do not read whole" banner. Query the tool instead. Those
  files are for humans and for grep.
- Every tool result is capped (rows and bytes). If you see `showing X of Y` or a
  truncation notice, that is the budget working — narrow the query rather than
  asking for more. **Warnings are always kept first and never dropped by
  truncation**, so a truncated result has not hidden a drift or orphan from you.
- Tune the caps in `.ariadne/config.json` if your team wants different limits:
  `maxToolRows` (50), `maxToolBytes` (24000), `summaryThreshold` (40),
  `maxDiagramNodes` (30), `maxDocItems` (60).

## Troubleshooting AEGIS itself

**"No tools available" / the graph tools don't appear.**
1. Is the workspace trusted? AEGIS will not auto-register its server in
   Restricted Mode, deliberately.
2. VS Code ≥1.99 registers the server automatically; older versions need
   `.vscode/mcp.json` started from the MCP panel.
3. Is AEGIS installed here at all? Look for `.ariadne/`. If it's missing, the
   command is **AEGIS: Install into Workspace**.

**Answers look stale, or a file you just wrote isn't found.** Call `index_status`.
If `fresh=false`, the hooks aren't running (they refresh on commit, not on save —
uncommitted work is not indexed). Call `reindex`, or run **AEGIS: Rebuild Index**.

**A tool says "No message-edge data" / "No DB-layer data" / "No decision data".**
The index predates that capability. Rebuild it: `AEGIS: Rebuild Index`.

**A topic, table, or endpoint that clearly exists doesn't show up.**
- It may be built at runtime — check `message_flow` for `unresolved_expressions`.
- It may live in a repo that isn't in the indexed workspace. `module_map` shows
  what's actually indexed; if a repo is missing, it needs to be part of the
  VS Code workspace.
- The extraction may not cover that framework (Spring Cloud Stream, a gateway
  rewrite, GraphQL, gRPC). This is expected, documented, and fixable with a small
  extractor extension — say so rather than pretending the thing doesn't exist.

**The graph and the code disagree.** Trust the code, reindex, and report the
discrepancy. A wrong graph answer is a bug worth a thumbs-down and an issue, not
something to quietly work around.

**`explain` returns nothing, or says STALE.** Insights are generated by the
enrichment pass and cached by content hash. Run **AEGIS: Enrich Insights via
Copilot**, or synthesize the understanding yourself from the graph and persist it
with `save_insight` so the next session doesn't pay for it again.

## Rules

- When you don't know whether the graph covers something, check `index_status`
  and `module_map` before answering. Guessing about your own tools is the one
  place you have no excuse.
- Never present a graph answer as certain when the tool itself flagged
  uncertainty (unresolved expressions, orphans, heuristic call matching). Pass the
  caveat through.
- If the toolkit is genuinely broken, say so plainly and fall back to reading
  files — but say that you're falling back, and why.
