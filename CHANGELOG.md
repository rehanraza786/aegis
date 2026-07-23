# Changelog

Versions below are the **payload/engine** version (npm `aegis-ariadne`, PyPI
`aegis-ariadne`, and the `payload_version` that `index_status` reports). The
VS Code extension versions independently via release tags.

## 0.2.0

The post-review release. Highlights, roughly in the order they landed:

- **Correctness:** strict-YAML-valid skill/agent frontmatter; Kotlin `const val`
  constants and `[...]` topic arrays; `${API_BASE}`-style dynamic base URLs now
  correlate with endpoints; `application.properties` placeholder resolution
  actually works; transient git failures can no longer wipe the index;
  `graph-assertions.json` is never clobbered on parse failure; the Python
  edition's `save_insight` works, its writers wait out the indexer's lock, its
  tools return structured results so warnings survive truncation, and `reindex`
  no longer blocks the MCP session.
- **Graph view:** `AEGIS: Open Graph View` renders modules/topics/tables with
  warnings badged and asserted edges dashed; the Gaps panel is a human worklist
  whose annotations flow back with their own provenance (`asserted:human`).
  New `graph_export` (documented JSON contract) and `annotate` CLIs. The panel
  never freezes the editor anymore (exports/annotations run async), a stale
  index announces itself with a banner + one-click incremental reindex (the
  export now carries `indexed_sha`/`head_sha`/`fresh`, verified per root in
  multi-repo workspaces), the selected node survives refreshes, capped lists
  read "showing N of M" instead of truncating silently, and submitting an
  assertion auto-ingests it via incremental reindex — no modal, no `--full`.
  The editing pass: an **Assertions panel** renders the whole human knowledge
  layer (kind, subject, confidence, author, evidence, file:line) with STALE
  entries floating to the top as a re-verification worklist, backed by two new
  annotate actions — `retract` and `reaffirm` (source_hash moves to the
  evidence file's current hash) — in both editions, suite-pinned; module
  notes show their text in details. Notes attach to topics and tables too
  (insight kinds widened past module|file), and a topic node offers a
  directional assert form anchored to a real site — the graph is editable
  wherever it makes a claim.
  Then the viewing pass: search over every node (`/`, arrows, Enter jumps and
  focuses), click-to-focus dims everything outside the neighborhood (Esc
  restores), the HTTP-endpoint layer finally renders (green tags, serves/calls
  edges, uncalled ones warn-bordered), layouts are deterministic (seeded
  positions + `randomize:false`) and survive layer toggles AND closing the
  panel (positions/viewport persist to workspace state), the panel refreshes
  itself when anything reindexes (debounced watcher; unchanged indexes are
  never re-exported), edge labels level-of-detail past a zoom threshold, and
  `f`/`r` keyboard shortcuts. The LOD work also surfaced and fixed a webview
  renderer crash (class mutation inside the zoom event is now rAF-deferred).
- **Performance:** FK indexes on every cascade path — a 200-file incremental
  reindex drops ~2.7× on a 1,540-file repo. Then the deep pass: newline-offset
  line math (the per-match prefix re-scan was O(text²) on big files),
  segment-boundary suffix-map import resolution (was O(imports × paths), and
  no longer fabricates edges from mid-segment matches), `executemany` batching
  and connection-lifetime prepared statements, one reused WASM parser per
  language in the Node edition (`new Parser()` per file leaked WASM heap), an
  LRU-bounded (64 MB) extraction text cache, FTS segment merge after bulk
  loads, and a cached read-only server connection (Python) — a cold full index
  drops 8.3× on a 1,500-file repo and 15.4× on a 5,000-file repo (Python
  edition; identical graph rows), with `tests/bench.py` to reproduce. FTS
  chunk deletes now ride the trigram index instead of full-scanning the
  chunk table per file (measured 35× at 100k chunks, exactness pinned by a
  suite check), the WAL file is truncated after full indexes instead of
  sitting at ~DB size, and `PRAGMA optimize` runs on indexer exit.
- **Extensibility:** extractor hooks accept a file scope (`{ fn, files: /\.go$/ }`)
  and run over any tracked file, making non-JVM stacks first-class; sample
  file-scoped extractor included.
- **Non-JVM seams built in:** endpoints from Express/Fastify/Router, Nest,
  Flask, and FastAPI; Python `requests`/`httpx` callers (cross-language HTTP
  correlation); Flyway/Prisma/Rails/Alembic schema definitions; SQLAlchemy and
  literal driver SQL access; RabbitMQ (amqplib/pika/`@RabbitListener`), JMS,
  SQS, and NATS edges labeled by `system` — and `rabbitTemplate`/`jmsTemplate`
  no longer masquerade as Kafka producers.
- **Config-validated messaging seam:** topic-ish keys in `application*` config
  are recorded as declarations; topics declared but never used are flagged
  (the messaging twin of table drift), topics link to the config keys that
  declare them, and hardcoded literals for declared topics get a
  hoist-to-config note — in `message_flow`, `graph_gaps`, the graph export,
  and the graph view's worklist.
- **Security:** `.ariadne/extensions/` is gated by explicit, committed,
  PR-reviewed approval (`--approve-extensions` → `extensions.lock`); the VS Code
  extension spawns with argument arrays (no shell interpolation); dependency
  pins keep the AST engine offline-capable.
- **Distribution:** installable as `npx aegis-ariadne` / `uvx aegis-ariadne`;
  GitHub Actions CI template + provider-aware `pull-index.sh` (GitLab and
  GitHub); releases are suite-gated with checksums; optional Marketplace and
  Open VSX publishing; `index_status` reports `payload_version`.
- **Installer robustness:** one converged hook engine (worktrees,
  `core.hooksPath`, chaining, space-safe, repo-move-safe), no hard python3
  dependency, atomic config writes. The Python installer is now `bootstrap.py`
  (a `setup.py` beside `pyproject.toml` would be executed by build tooling).
- **Multi-host prompt layer:** `install.sh --host=copilot|claude|cursor|agents|all`
  delivers skills/agents/routing/MCP config to Claude Code (`.claude/`,
  `CLAUDE.md`, `.mcp.json`), Cursor (`.cursor/`), and generic `AGENTS.md`
  hosts; standing rules in `agent-context.md` are derived from what the graph
  detected instead of asserted universally.
- **Project hygiene:** CONTRIBUTING (with the extractor-PR path), SECURITY
  policy and threat model, issue/PR templates, CODEOWNERS, dependabot, CI
  badge, `docs/ARCHITECTURE.md`, and `docs/TOOLS.md` (suite-pinned to the
  live tool registry).
- **MCP surface completed:** the server speaks all three MCP primitives now.
  Four prompts rendered server-side from live graph queries (`/aegis-impact`,
  `/aegis-orient`, `/aegis-resolve-gap`, `/aegis-release-check`); six
  `ariadne://` resources (graph export, status, agent context, decision
  ledger + per-ADR template, assertions with computed staleness) with real
  subscription support — `resources/updated` + `list_changed` fan out when
  the index moves, whether via the `reindex` tool or a hook outside the
  process; composite decision tools `plan_context(task)` (task →
  files/seams/decisions/tests in one call) and `change_check(files)`
  (pre-edit blast radius, tests to re-run, seam warnings, governing ADRs,
  assertions the edit stales); and `readOnlyHint` annotations on all 26
  tools (the four writers marked non-read-only, non-destructive). Registry
  parity across editions is suite-pinned for tools, prompts, resources, AND
  annotations; the Python edition gained its first full stdio protocol
  round-trip test in the process.
- **Engine (schema v6):** the per-file pipeline is split on the single-writer
  boundary — compute (I/O + hash + parse + extract) runs in a worker pool
  (`worker_threads` / `ProcessPoolExecutor`; auto-sized, `--workers 1` or
  `"workers": 1` forces sequential, small batches stay sequential
  automatically) while all writes stay on one thread in submission order, so
  parallel and sequential runs build identical graphs (suite-pinned).
  Config-delta scoping: an edited constant/entity/config key re-extracts only
  the files that mention a changed key instead of every candidate in the repo
  (full widen stays as the >50-key / unknown-map fallback). FTS moves to
  external content: file text lives once in `chunk_text` (roughly halving
  index.db), `snippet()`/`rank` read through, per-file chunk deletes ride a
  plain B-tree index, and a pre-v6 index migrates itself with a one-time full
  rebuild on the next indexing run — while read-side opens (`--status`) leave
  it untouched.
- **Graph view closes the loop:** PNG/SVG export of the current map (PNG from
  the canvas; SVG from a first-party serializer for the view's four node
  shapes, because the common cytoscape SVG plugin is GPLv3 and cannot ship in
  this MIT vsix) with the provenance encoding intact — and drag-to-connect:
  toggle ✏ Assert edge, drag module → topic/table/endpoint (or topic/table →
  module), and the gesture becomes a prefilled assertion form that still
  demands the anchor file:line and evidence. cytoscape-edgehandles (MIT) is
  bundled self-contained; zero egress as always. The suite also gained a
  deterministic routing eval: canonical utterances must route to their
  intended skills by description token overlap, so trigger drift fails CI.

## 0.1.0

First cut.
