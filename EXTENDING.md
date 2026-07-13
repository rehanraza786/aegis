# Extending AEGIS

Every layer is pluggable. Extensions are plain files dropped into the repo.
no build step, no registration, versioned with your code.

| Layer | How to extend | Contract |
|---|---|---|
| **Graph engine** | `aegis.json` → `graphEngine` + `mcp.command/args` | any stdio MCP server |
| **Indexer passes** | `.ariadne/extensions/*.pass.mjs` / `*.pass.py` | export `run(ctx)`; ctx = `{db/con, tracked, readText, idByPath, inScope, log}`, create your own tables, they cascade-clean with files |
| **MCP tools** | `.ariadne/extensions/*.tool.mjs` / `*.tool.py` | export `register({tool, z, withDb})` (node) / `register(mcp, db)` (python) |
| **Generated docs** | `.ariadne/extensions/doc-*.mjs` / `doc-*.py` | export `generate({q, write, mmId/mm, svc})`, emit md into docs/generated/ |
| **Seam extractors** | `.ariadne/extensions/*.extract.mjs` / `*.extract.py` | export `extractors = { kafka, dbAccess, httpEndpoints, httpCalls }`, each `(text, ctx) -> rows[]`; rows land in the NATIVE tables, so they flow through message_flow/db_map/http_map and docgen automatically. Sample: `spring-cloud-stream.extract.*` (functional bindings). This is the intended path for gateway base-paths, gRPC, GraphQL, or any house framework |
| **Insight providers** | `enrich --plan` → run any LLM → `enrich --apply results.json` | plan items: `{target, kind, hash, prompt}`; results add `summary`, `model`. The Copilot command in the VS Code extension is exactly this loop over `vscode.lm` |
| **Insight writers** | the `save_insight` MCP tool | any agent (Copilot, Claude, …) persists synthesized understanding; hash-keyed, auto-stales |
| **Skills & agents** | drop files in `.github/skills/` and `.github/agents/` | open Agent Skills / agent-file standards |

**Working sample:** `payload/extensions-samples/todo.*` implements a full
vertical, a pass that scans TODO/FIXME into a `todos` table plus a `todos`
MCP tool, in ~40 lines per edition. Copy into `.ariadne/extensions/` to
activate; the self-test suite runs it as its extension-hook fixture.

Rules of the road: extensions run inside the index transaction (fail-safe:
errors are logged, never abort indexing); scope-aware extensions should honor
`inScope(rel)`; prefix your tables to avoid collisions; and if you add tables
referencing `files(id)`, use `ON DELETE CASCADE` so pruning stays clean.
