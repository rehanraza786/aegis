# Ariadne tool reference

All 26 MCP tools — plus 4 server-rendered prompts and 6 `ariadne://`
resources — identical across both editions (a suite check pins the tool,
prompt, and resource registries equal, and pins this document to them). Every
result is budget-capped (rows and bytes, warnings kept first); every error
returns as a message the agent can adapt to, never a crash. Params marked ?
are optional.

Every tool carries MCP annotations: `readOnlyHint: true` on the 22 read-only
tools, and the four writers (`save_decision`, `save_insight`, `assert_edge`,
`reindex`) marked non-read-only and non-destructive — so hosts can parallelize
reads and gate writes.

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

## Composite decision tools

**`plan_context`** (task) → when you have a TASK but no target yet: full-text
+ symbol matches for the task's terms, the files they concentrate in
(`files_to_read`, with why each matched), the seams those files touch, the
governing decisions, and the tests that cover them. One call instead of the
3–5 exploratory searches every session used to open with; follow with
`context_pack` on the target you choose.

**`change_check`** (files[]) → pre-edit decision support for a whole edit set:
combined blast radius, `tests_to_rerun`, per-file seam participation, seam
warnings the edit could trip (sole producer/consumer of a topic, drift tables,
uncalled endpoints, unresolved expressions in these files), governing ADRs,
and the assertions the edit will mark STALE. Call BEFORE proposing a diff.

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
blocks the session). Use when `index_status` says `fresh: false`. On
completion, subscribed resource readers get `notifications/resources/updated`.

## Prompts

Four graph-aware recipes, rendered SERVER-SIDE from live queries at request
time — hosts that support MCP prompts surface them as slash commands. The
rendered text carries current facts (blast radius, seams, decisions), never a
static template.

**`/aegis-impact`** (target) → "what am I about to break": blast radius,
tests to re-run, seams touched, governing decisions, assertions the edit will
stale — and the pre-edit protocol.

**`/aegis-orient`** (module) → first encounter with a module: file/language
shape, the most-depended-on entry points, seams, decisions, cached insight,
and the suggested reading order.

**`/aegis-resolve-gap`** () → the top open gap from the graph's worklist
(dismissed items skipped), the investigation protocol, and the `assert_edge`
contract (evidence quotes code, ≥20 chars; never assert from naming alone).

**`/aegis-release-check`** () → pre-release review: schema drift, orphan
topics, uncalled endpoints, unresolved expressions, stale assertions —
each with the tool that investigates it, dismissed items excluded but counted.

## Resources

Context a host can ATTACH without spending tool calls. Subscribe to any of
these and the server emits `notifications/resources/updated` (plus one
`resources/list_changed`) whenever the index moves — after the `reindex` tool,
and within ~2s of a hook- or agent-triggered reindex outside this process.

**`ariadne://graph`** → the full graph-export JSON snapshot (modules, topics,
tables, endpoints, gaps, annotations), cached until the index moves.

**`ariadne://status`** → freshness JSON; the resource twin of `index_status`.

**`ariadne://context`** → `docs/generated/agent-context.md`, the graph-derived
orientation pack.

**`ariadne://decisions`** → the decision ledger (id, title, status, validity).

**`ariadne://decisions/{id}`** → one ADR as markdown (the git-versioned source
file when present, else the indexed summary).

**`ariadne://assertions`** → the human knowledge layer:
`docs/graph-assertions.json` with a computed `stale` flag per assertion.
