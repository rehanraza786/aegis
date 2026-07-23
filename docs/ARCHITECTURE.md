# Ariadne architecture

How the engine is put together — the document EXTENDING.md presupposes.

## The contract is the database

Two editions (`payload/ariadne-node`, `payload/ariadne-python`) implement the
same engine against one SQLite file, `.ariadne/index.db`. Either edition can
build it; either can serve it; CI can build it and laptops can pull it. That
file format — plus the JSON side-channels (`docs/graph-assertions.json`,
`docs/adr/*.md`, `.ariadne/extensions.lock`, the `graph_export` schema) — is
the real interface. Everything else is replaceable, which is what `aegis.json`'s
engine registry formalizes.

## Tables

| Table | What it holds |
|---|---|
| `files` | path, lang, content sha1, size/mtime, `is_test` (path conventions + config overrides) |
| `symbols` | name/kind/line/signature/`parent` per file — tree-sitter for the AST six, regex tier otherwise; Lombok accessors synthesized |
| `calls` | heuristic call graph (src symbol → callee name) |
| `edges` | file→file import edges (`kind='import'`), plus SCIP `ref` edges after ingest |
| `chunk_text` | file text in 40-line windows — stored ONCE (schema v6) |
| `chunks` | FTS5 trigram index, external-content over `chunk_text` (kept in sync by triggers; `snippet()`/`rank` read through) |
| `msg_edges` | messaging seam: `system` (kafka/rabbit/jms/sqs/nats), topic, direction, `resolved`, `via`, `source` |
| `msg_topics` | topics DECLARED in application config: the seam's source of truth (config key + line) |
| `db_defs` | schema history: table/op/changeset from Liquibase, Flyway, Prisma, Rails, Alembic |
| `db_access` | code touching tables: kind (entity/repository/sql), read-write mode, detail, `source` |
| `http_endpoints` / `http_calls` | the HTTP seam, both sides, normalized paths (`norm`), `source` |
| `assertions` | human/agent-derived facts ingested from `docs/graph-assertions.json` |
| `decisions` / `decision_links` | ADRs with temporal validity (supersession) and governed targets |
| `insights` | cached LLM/human summaries, content-hash keyed so they auto-stale |
| `extract_cache` | per-file hash + extracted constants/entities — the incremental-extraction memory |
| `scip_defs` / `scip_refs` | compiler-grade layer, ingested from scip-java / scip-typescript output |
| `test_cases` | test names per test file, decamelized into behaviors for `context_pack` |
| `meta` | schema version, per-root last-indexed SHAs, config fingerprint |

Every child table carries an indexed FK to `files(id)` with `ON DELETE CASCADE`:
deleting a file row atomically removes everything derived from it — that
cascade is the whole incremental-consistency story, and the FK indexes are what
keep multi-file reindexes linear.

## The passes

`indexer --full` (or `--incremental`, driven by `git diff last-sha..HEAD` with
a fall-back to full when the stamp is unreachable or the diff is huge):

1. **File pass** — `git ls-files` per root (never the filesystem), hash check
   (size+mtime fast path, then sha1), parse changed files: tree-sitter symbols
   + calls, imports, FTS chunks, test-case names. Compute (I/O + parse +
   extract) runs in a worker pool on big batches — `worker_threads` (Node) /
   `ProcessPoolExecutor` (Python) — while ALL writes stay on one thread, in
   submission order; `--workers 1` forces sequential. Prune deleted files
   (guarded: an empty listing against a non-empty index refuses rather than
   wipes).
2. **Import edges** — per-language import extraction resolved against tracked
   paths (suffix map), cross-module only.
3. **Correlation pass** (`kafkaPass` — historically named, now all seams):
   - config fingerprint over `application*` files; a change diffs the KEY
     set (config keys, constants, entity names) and widens only to files that
     mention a changed key — falling back to a full re-extract when the key
     set is large or unknown, so correctness never depends on the scoping
   - repo-wide constant + `@Entity` maps from `extract_cache` (recomputed only
     on hash miss; test files never pollute the global maps, but overlay their
     own locals)
   - per-seam extraction over the *dirty* set only: messaging (JVM +
     amqplib/pika/boto3/nats), config topic declarations, changelogs + schema
     files, DB access (JVM + SQLAlchemy/driver SQL), Lombok synthesis, HTTP
     endpoints/calls (JVM + Express/Nest/Flask/FastAPI + TS/Python clients)
   - extension hooks: default-scope (java/kotlin) and file-scoped
     (`{fn, files}`), trust-gated by `extensions.lock`
4. **Assertions ingest** — `docs/graph-assertions.json` → `assertions` +
   seam rows tagged `source='asserted:<author>'`, marked STALE when the
   evidence file's hash moved.
5. **Decisions ingest** — `docs/adr/*.md` parsed into the temporal model.
6. **Extension passes** (`*.pass.*`) inside the same transaction, fail-safe.

Everything runs in one transaction per index run; a lockfile
(`.ariadne/.index.lock`) serializes concurrent runs.

## Provenance: two orthogonal axes

`source` answers WHO derived a fact: `static` (parsed) vs `asserted:<author>`
(derived — model or human, and the graph view writes `asserted:human`).
`files.is_test` answers WHERE the code lives. They never mix: topology and
drift math are production-only; test usage is labeled `[TEST]` and listed, never
counted as a cure; asserted facts are labeled everywhere they surface.

## Budget philosophy

No tool result may flood a model's context: row caps keep warning-bearing
entries first and never drop them; byte caps truncate tails, which is why every
result places summary + warnings before detail. Docs generated past
`maxDocItems` carry a do-not-read-whole banner. `graph_export` uses a larger
UI-scale ceiling (`maxExportItems`) with the same warnings-first rule.

## Serving

Each edition's `server` registers the same 24 MCP tools (a suite check pins the
registries equal — see docs/TOOLS.md) over stdio, opens the DB read-only with
reopen-on-swap, and loads trust-approved `*.tool.*` extensions. Writer tools
(`save_decision`, `save_insight`) use short-lived connections with a 10s busy
timeout so they wait out an in-flight index instead of failing.

## Multi-root workspaces

`ARIADNE_ROOTS` (comma list) puts the engine in workspace mode: paths are
prefixed with the repo directory name, one shared DB lives in the workspace's
`.ariadne/`, per-root SHAs are stamped for incremental diffs, and hooks
installed by setup export the roots so background indexes hit the shared DB.
