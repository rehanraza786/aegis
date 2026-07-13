# Token-Efficiency Toolkit (all free)

Everything here reduces the tokens Copilot (or any coding agent) burns per task.
Ranked by impact-per-effort for an 8-dev team.

## Tier 1 — biggest wins, already in your setup

**1. The Ariadne MCP server (this bundle).**
Structural questions become 2 tool calls returning JSON rows instead of a
grep-and-read spiral. `find_references`/`blast_radius` with SCIP data replace
the single most expensive agent behavior: reading files to trace usage.

**2. `.github/copilot-instructions.md` routing (tiny file, huge leverage).**
Always-on instructions are loaded into every request — keep them SHORT (a
bloated instructions file *costs* tokens on every single request). Use it only
to route: "prefer the graph tools; read the knowledge base before source."
Everything detailed goes in skills, which load only when relevant.

**3. Agent Skills' progressive disclosure (your earlier bundles).**
Skills cost ~zero until triggered. Move any long guidance out of
copilot-instructions and into a skill. Same knowledge, paid for only when used.

**4. The `.github/knowledge/` prose KB (your earlier bundle).**
Complements the graph: the graph answers "where/what depends on what";
the KB answers "why/how does this module work" in ~150 lines instead of
re-reading the module.

## Tier 2 — configuration, minutes each

**5. Content exclusion / ignore files.**
Repo Settings → Copilot → content exclusion (org/repo level): exclude
generated code, lockfiles, fixtures, vendored deps, build output. Excluded
files never enter context — pure savings. Biggest offenders in a Java+TS
repo: `package-lock.json`, generated API clients, `*.min.js`, test fixtures,
migration dumps.

**6. Reusable prompt files (`.github/prompts/*.prompt.md`).**
For tasks your team repeats (add endpoint, add component, write migration),
a prompt file with the exact steps + file references beats each dev
re-explaining context in chat every time. Free, versioned, shared.

**7. Pin cheaper models per agent (`model:` in .agent.md frontmatter).**
Your custom agents can run on a smaller/cheaper model for mechanical tasks
(standup notes, formatting, test scaffolding) and reserve the big model for
architecture. With good skills + the graph server, small models punch far
above their weight — that was the original goal of this whole setup.

## Tier 3 — habits that compound

**8. Fresh chats per task.** Long chat histories are resent with every
message. New task → new chat. The graph/KB means a fresh chat re-orients in
hundreds of tokens, so there's no longer a reason to keep mega-threads alive.

**9. Reference, don't paste.** `#file`, `@workspace`, and MCP tools let the
agent pull precisely what it needs. Pasting whole files puts them in history
forever (see #8).

**10. Scope prompts to modules.** "Fix the retry logic in
`frontend/src/api/client.ts`" starts a 3-file exploration; "fix retry logic
somewhere in the app" starts a 300-file one. The `module_map` +
`find_symbol` tools make precise scoping effortless.

## Free/open-source tools referenced

| Tool | License | Role |
|---|---|---|
| scip-typescript, scip-java | Apache-2.0 | compiler-grade indexing |
| SQLite + FTS5 | Public domain | local graph + lexical search |
| tree-sitter (optional upgrade) | MIT | parser-grade extraction |
| GitHub CLI (`gh`) | MIT | pulling shared CI-built index |
| GitHub Actions | free tier (2,000 min/mo private, unlimited public) | shared index builds |
| MCP SDK (`mcp` pip package) | MIT | the server framework |

## What NOT to bother with

- **Embeddings/vector DBs for a repo this size** — lexical FTS + a real
  symbol graph answers code questions more precisely than semantic
  similarity, with zero API cost and no drift. Revisit only if you want
  natural-language search over docs/comments at scale.
- **CodeQL as a graph source** — powerful, but its license doesn't permit
  this use on private commercial code.
- **Giant "context dump" files** (single ARCHITECTURE.md with everything) —
  they get fully loaded when touched. Layering (INDEX → module files → graph
  tools) is the entire trick.
