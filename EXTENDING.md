# Extending AEGIS

Every layer is pluggable. Extensions are plain files dropped into the repo: no build
step, no registration, and they are versioned alongside your code.

| Layer | How to extend | Contract |
|---|---|---|
| **Graph engine** | `aegis.json` → `graphEngine` + `mcp.command/args` | any stdio MCP server |
| **Indexer passes** | `.ariadne/extensions/*.pass.mjs` / `*.pass.py` | export `run(ctx)`; ctx = `{db/con, tracked, readText, idByPath, inScope, log}`, create your own tables, they cascade-clean with files |
| **MCP tools** | `.ariadne/extensions/*.tool.mjs` / `*.tool.py` | export `register({tool, z, withDb})` (node) / `register(mcp, db)` (python) |
| **Generated docs** | `.ariadne/extensions/doc-*.mjs` / `doc-*.py` | export `generate({q, write, mmId/mm, svc})`, emit md into docs/generated/ |
| **Seam extractors** | `.ariadne/extensions/*.extract.mjs` / `*.extract.py` | export `extractors = { kafka, dbAccess, httpEndpoints, httpCalls }`, each `(text, ctx) -> rows[]`; rows land in the NATIVE tables, so they flow through message_flow/db_map/http_map and docgen automatically. Sample: `spring-cloud-stream.extract.*` (functional bindings). This is the intended path for gateway base-paths, gRPC, GraphQL, or any house framework |
| **Insight providers** | `enrich --plan` → run any LLM → `enrich --apply results.json` | plan items: `{target, kind, hash, prompt}`; results add `summary`, `model`. The Copilot command in the VS Code extension is exactly this loop over `vscode.lm` |
| **Insight writers** | the `save_insight` MCP tool | any agent (Copilot, Claude, …) persists synthesized understanding; hash-keyed, auto-stales |
| **Visual clients** | `graph_export.mjs`/`.py` (read) + `annotate.mjs`/`.py` (write-back) | the graph-view contract below; the VS Code graph view is the reference client |
| **Skills & agents** | drop files in `.github/skills/` and `.github/agents/` | open Agent Skills / agent-file standards |

**Working sample:** `payload/extensions-samples/todo.*` implements a full
vertical, a pass that scans TODO/FIXME into a `todos` table plus a `todos`
MCP tool, in ~40 lines per edition. Copy into `.ariadne/extensions/` to
activate; the self-test suite runs it as its extension-hook fixture.

Rules of the road: extensions run inside the index transaction (fail-safe:
errors are logged, never abort indexing); scope-aware extensions should honor
`inScope(rel)`; prefix your tables to avoid collisions; and if you add tables
referencing `files(id)`, use `ON DELETE CASCADE` so pruning stays clean.

## The graph-view contract (visual clients)

`node .ariadne/graph_export.mjs` (or `python3 .ariadne/graph_export.py`) prints
one JSON document on stdout — a budget-capped snapshot the VS Code graph view
renders. Any engine that prints the same shape gets the view for free. Top-level
keys, `schema: 1`:

- `modules`: `[{id, files, langs, deps}]` — first-path-segment modules, capped at
  `maxDiagramNodes`, `deps` = cross-module import edges.
- `topics` / `tables` / `endpoints`: seam entries capped at `maxExportItems`
  (default 4×`maxDocItems` — a UI safety bound, not a context budget), each
  with site lists (`{items: [{path, line, via?, test?, asserted?, mode?/client?}], more?}`)
  capped per entry, and a `warnings` object (`orphan_produce`, `orphan_consume`,
  `test_only`, `unresolved_expression`, `drift_no_changeset`, `defined_but_unused`,
  `no_caller`). Warnings are computed over production code only; test usage is
  labeled, never counted as a cure.
- `gaps.unresolved_topic_expressions`: the human worklist, `{expression,
  direction, path, line}` each.
- `annotations`: insights (`{target, kind, by}`) and assertions
  (`{kind, file, line, confidence, author, stale?}`) already in the graph.

Write-back is `annotate.mjs`/`annotate.py '<json>'`, same semantics as the
`save_insight` / `assert_edge` MCP tools, with one addition: the default
provenance is **`human`** (insights land as `human:graph-view`, assertion edges
as `asserted:human`), so a person's annotation is distinguishable from both a
parsed fact and a model's inference, everywhere it appears.

One provenance rule for seam rows: `source` stays two-valued (`static` for
parsed, `asserted:<author>` for derived), never encode test-ness there. Whether
code is test code lives on `files.is_test` (JOIN `files` for it), set from path
conventions plus the `testPathPatterns` / `prodPathPatterns` regex arrays in
`.ariadne/config.json`.
