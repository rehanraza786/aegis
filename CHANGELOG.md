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
  New `graph_export` (documented JSON contract) and `annotate` CLIs.
- **Performance:** FK indexes on every cascade path — a 200-file incremental
  reindex drops ~2.7× on a 1,540-file repo.
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

## 0.1.0

First cut.
