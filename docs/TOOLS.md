# Ariadne tool reference

All 24 MCP tools, identical across both editions (a suite check pins the
registries equal, and pins this document to the registry). Every result is
budget-capped (rows and bytes, warnings kept first); every error returns as a
message the agent can adapt to, never a crash. Params marked ? are optional.

## Orientation

**`index_status`** () → files/symbols/edges counts, `indexed_sha` vs
`head_sha`, `fresh`, `payload_version`. Call first when results look stale.

**`module_map`** (prefix?) → per-directory file counts and main languages.
First call in an unfamiliar repo.

**`context_pack`** (target) → ONE call assembling everything about a file,
class, or method: outline, callers, blast radius, the topics/tables/endpoints
it touches, governing decisions, cached insight, and the tests that cover it.
Use instead of six separate lookups when starting work.

**`hotspots`** (limit?=10) → most-depended-on files (highest in-degree) —
the highest-risk files to change.

## Code structure

**`search_code`** (query, limit?=8) → FTS matches with path, start line,
snippet, and enclosing symbol.

**`find_symbol`** (name, exact?=false) → symbols by name with kind, signature,
parent, location.

**`file_outline`** (path) → a file's skeleton: symbols, imports, importers —
instead of reading the file.

**`dependencies`** (path) → what a file imports (in-repo).

**`blast_radius`** (path, depth?=2) → transitive reverse dependencies by
depth, production and `tests_affected` separated. Call BEFORE modifying shared
code.

**`find_callers`** (name, limit?=40) / **`find_callees`** (name) → heuristic
AST call graph, matched by name.

**`find_references`** (name, limit?=40) / **`goto_definition`** (name) →
compiler-grade (requires SCIP ingest): every real use / the exact definition
with docs. Fall back to `find_symbol`/`search_code` when SCIP isn't ingested.

## Seams

**`message_flow`** (topic?) → messaging topology across systems (kafka,
rabbit, jms, sqs, nats — non-kafka sites labeled). Unscoped on large systems:
summary + complete warning lists (orphans, test-only, unresolved,
declared-in-config-but-unused). Scoped: per-topic sites with `config_keys`
linkage and a hoist-to-config note when declared names are hardcoded.

**`db_map`** (table?) → tables ↔ changesets ↔ access sites with read/write
mode. Drift warnings: accessed-but-no-changeset, defined-but-never-accessed.

**`http_map`** (path?) → endpoints ↔ callers matched on method + normalized
path, cross-language. Warnings: endpoints nobody calls, calls matching no
endpoint.

## Where the graph is blind — and how it learns

**`graph_gaps`** (limit?=20) → the graph's own worklist: unresolved topic
expressions, orphan topics, config-declared-but-unused topics, drift tables,
uncalled endpoints — each with file:line. Investigate, then record with
`assert_edge`.

**`assert_edge`** (kind: kafka|db|http_endpoint|http_call, file, line,
evidence ≥20 chars, confidence?: high|medium|low, topic?, direction?, table?,
mode?, method?, path?) → records a derived fact in
`docs/graph-assertions.json` (committed, PR-reviewed), enters the graph tagged
`asserted:<author>`, auto-STALE when the evidence file changes. Never clobbers
a malformed file; never assert from naming alone.

## Memory

**`explain`** (target) → cached insight for a module/file, with staleness
flag.

**`save_insight`** (target, kind: module|file, summary ≥40 chars) → persist
synthesized understanding, content-hash keyed.

**`decisions`** (query?, target?, status?, as_of?) → ADRs with temporal
validity; `as_of` time-travels.

**`decision_trace`** (id) → one decision's full supersession chain +
governed artifacts with existence check (decision drift).

**`save_decision`** (title, decision, rationale, alternatives?, supersedes?)
→ writes a numbered ADR file AND indexes it immediately.

## Maintenance

**`reindex`** (mode?: incremental|full) → rebuild the index (async; never
blocks the session). Use when `index_status` says `fresh: false`.
